/**
 * xAI Grok provider — direct HTTP Chat Completions transport.
 *
 * This is intentionally smaller than Codex: no CLI, no subprocess, no
 * provider-owned home directory. It uses the OpenAI-compatible xAI endpoint
 * through OneCLI's egress proxy; the Authorization header value is a managed
 * stub that OneCLI replaces on the wire.
 */
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4.3';
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TOOL_ROUNDS = 8;

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface McpToolHandle {
  serverName: string;
  toolName: string;
}

interface McpClientHandle {
  name: string;
  client: Client;
  transport: StdioClientTransport;
}

interface SessionState {
  messages: ChatMessage[];
}

const sessions = new Map<string, SessionState>();

function log(msg: string): void {
  console.error(`[xai-provider] ${msg}`);
}

function makeSessionId(): string {
  return `xai_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function authHeader(token: string | undefined): string {
  return `Bearer ${token || 'onecli-managed'}`;
}

function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      return resolveClaudeImports(fs.readFileSync(resolved, 'utf-8'), path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentInstructions(cwd: string, addendum: string | undefined): string | undefined {
  const pieces: string[] = [];
  for (const filename of ['CLAUDE.md', 'CLAUDE.local.md']) {
    const fullPath = path.join(cwd, filename);
    if (fs.existsSync(fullPath)) {
      pieces.push(resolveClaudeImports(fs.readFileSync(fullPath, 'utf-8'), cwd));
    }
  }
  if (addendum) pieces.push(addendum);
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

function stringEnv(...envs: Array<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const env of envs) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

class McpToolBridge {
  private readonly servers: Record<string, McpServerConfig>;
  private clients: McpClientHandle[] = [];
  private toolMap = new Map<string, McpToolHandle>();
  private toolSpecs: ToolSpec[] | null = null;

  constructor(servers: Record<string, McpServerConfig>) {
    this.servers = servers;
  }

  async listTools(): Promise<ToolSpec[]> {
    if (this.toolSpecs) return this.toolSpecs;

    const specs: ToolSpec[] = [];
    for (const [serverName, server] of Object.entries(this.servers)) {
      try {
        const transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: stringEnv(process.env, server.env),
        });
        const client = new Client({ name: `nanoclaw-xai-${serverName}`, version: '1.0.0' });
        await client.connect(transport);
        this.clients.push({ name: serverName, client, transport });

        const result = await client.listTools();
        for (const tool of result.tools ?? []) {
          const functionName = `${serverName}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
          this.toolMap.set(functionName, { serverName, toolName: tool.name });
          specs.push({
            type: 'function',
            function: {
              name: functionName,
              description: tool.description,
              parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            },
          });
        }
      } catch (err) {
        log(`MCP server ${serverName} unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.toolSpecs = specs;
    return specs;
  }

  async call(functionName: string, rawArgs: string): Promise<string> {
    const handle = this.toolMap.get(functionName);
    if (!handle) return `Tool ${functionName} is not available.`;

    const client = this.clients.find((c) => c.name === handle.serverName)?.client;
    if (!client) return `MCP server ${handle.serverName} is not connected.`;

    let args: Record<string, unknown>;
    try {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return `Invalid JSON arguments for ${functionName}: ${rawArgs}`;
    }

    try {
      const result = await client.callTool({ name: handle.toolName, arguments: args });
      return stringifyToolResult(result);
    } catch (err) {
      return `Tool ${functionName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.clients.map(async ({ client, transport }) => {
        await client.close();
        await transport.close();
      }),
    );
  }
}

function stringifyToolResult(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export class XaiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly usesMemoryScaffold = true;

  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly model: string;
  private readonly effort: string | undefined;
  private readonly mcpServers: Record<string, McpServerConfig>;

  constructor(options: ProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.env?.XAI_BASE_URL);
    this.authToken = options.env?.XAI_AUTH_TOKEN;
    this.model = options.model || options.env?.XAI_MODEL || DEFAULT_MODEL;
    this.effort = options.effort;
    this.mcpServers = options.mcpServers ?? {};
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /unknown xai session|invalid continuation/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const controller = new AbortController();

    const kick = (): void => {
      waiting?.();
      waiting = null;
    };

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      const bridge = new McpToolBridge(self.mcpServers);
      const continuation = input.continuation && sessions.has(input.continuation) ? input.continuation : makeSessionId();
      let session = sessions.get(continuation);
      if (!session) {
        const system = readAgentInstructions(input.cwd, input.systemContext?.instructions);
        session = { messages: system ? [{ role: 'system', content: system }] : [] };
        sessions.set(continuation, session);
      }

      yield { type: 'init', continuation };

      try {
        while (!aborted) {
          while (pending.length === 0 && !ended && !aborted) {
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
          }
          if (aborted || (pending.length === 0 && ended)) return;

          const text = pending.shift()!;
          session.messages.push({ role: 'user', content: text });
          yield* self.runChatLoop(session, bridge, controller.signal);
        }
      } finally {
        await bridge.close();
      }
    }

    return {
      push: (message: string) => {
        pending.push(message);
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      abort: () => {
        aborted = true;
        controller.abort();
        kick();
      },
      events: gen(),
    };
  }

  private async *runChatLoop(
    session: SessionState,
    bridge: McpToolBridge,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const tools = await bridge.listTools();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      yield { type: 'activity' };
      const response = await this.streamCompletion(session.messages, tools, signal);
      yield* response.events;

      session.messages.push({
        role: 'assistant',
        content: response.text || null,
        ...(response.toolCalls.length > 0 ? { tool_calls: response.toolCalls.map(toChatToolCall) } : {}),
      });

      if (response.toolCalls.length === 0) {
        yield { type: 'result', text: response.text || null, lastText: response.text || null };
        return;
      }

      for (const call of response.toolCalls) {
        yield { type: 'activity' };
        yield { type: 'progress', message: `tool: ${call.name}` };
        const output = await bridge.call(call.name, call.arguments);
        session.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }

    yield {
      type: 'error',
      message: `Stopped after ${MAX_TOOL_ROUNDS} tool-call rounds without a final answer.`,
      retryable: false,
      classification: 'tool_loop',
    };
  }

  private async streamCompletion(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal,
  ): Promise<{ text: string; toolCalls: PendingToolCall[]; events: ProviderEvent[] }> {
    const events: ProviderEvent[] = [];
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (this.effort) body.reasoning_effort = this.effort;

    const timer = AbortSignal.timeout(TURN_TIMEOUT_MS);
    const compositeSignal = AbortSignal.any([signal, timer]);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(this.authToken),
      },
      body: JSON.stringify(body),
      signal: compositeSignal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`xAI chat completion failed (${res.status}): ${errText || res.statusText}`);
    }
    if (!res.body) throw new Error('xAI chat completion returned no response body');

    let text = '';
    const toolCalls = new Map<number, PendingToolCall>();
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      events.push({ type: 'activity' });
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        const parsed = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) text += delta.content;

        for (const callDelta of delta.tool_calls ?? []) {
          const index = callDelta.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
          if (callDelta.id) existing.id = callDelta.id;
          if (callDelta.function?.name) existing.name += callDelta.function.name;
          if (callDelta.function?.arguments) existing.arguments += callDelta.function.arguments;
          toolCalls.set(index, existing);
        }
      }
    }

    const calls = [...toolCalls.values()].map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.name,
      arguments: call.arguments,
    }));
    return { text, toolCalls: calls, events };
  }
}

function toChatToolCall(call: PendingToolCall): ToolCall {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  };
}

registerProvider('xai', (opts) => new XaiProvider(opts));
