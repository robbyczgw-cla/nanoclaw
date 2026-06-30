# Patch 20 — selectively eager-load core reply tools

**File:** `container/agent-runner/src/mcp-tools/core.ts`
**Status:** 🟢 local-only (upstream has neither the bug context nor this fix)
**Applied:** 2026-06-30

## Background

`container/agent-runner/src/providers/claude.ts` allowlists `ToolSearch` and
exposes every nanoclaw MCP tool (~15) plus the SDK builtins. With that many
tools, the Claude Agent SDK **defers** lower-frequency tools behind on-demand
`ToolSearch` to keep the eager prompt small. `send_message` — needed on
nearly every turn to reply at all — got swept into the deferred set.

Opus 4.8 navigates the search→load→call dance fine. **Sonnet-5 loops on
it**: repeated `ToolSearch select:…send_message` calls, tool-noise leaking
into chats, replies sometimes not delivered at all.

## Fix — selective, not a sledgehammer

Removing `ToolSearch` from the allowlist would eager-load *everything*
(~35 tools): a fixed multi-thousand-token tax on every request, and a worse
tool-selection surface (more visible tools → higher chance of picking the
wrong one). Rejected.

Instead: the Claude Agent SDK supports a documented per-tool eager pin —
`_meta['anthropic/alwaysLoad']` on an individual MCP tool definition
(`sdk.d.ts` confirms this is the exact field the SDK's own `tool({alwaysLoad})`
/ `createSdkMcpServer({alwaysLoad})` helpers set under the hood; the doc
comment: *"Applied via `_meta['anthropic/alwaysLoad']` on each tool. Per-tool
`tool({ alwaysLoad })` still works and is OR'd with [the server-level
setting]."*).

Nanoclaw doesn't use those SDK helpers — `mcp-tools/server.ts` hand-rolls a
standalone `@modelcontextprotocol/sdk` stdio server (spawned as its own `bun`
subprocess, wired in via `McpStdioServerConfig` in `claude.ts`). Its `Tool`
type already carries a free-form `_meta?: Record<string, unknown>` field, so
the same mechanism applies directly: set `_meta: {'anthropic/alwaysLoad':
true}` on the 4 core reply tools' own `Tool` objects in `core.ts`.

```ts
tool: {
  name: 'send_message',
  ...
  _meta: { 'anthropic/alwaysLoad': true },
}
```

Applied to `send_message`, `send_file`, `edit_message`, `add_reaction` —
the four tools an agent needs on essentially every turn to reply at all.
Every other nanoclaw tool (`schedule_task`, `list_tasks`,
`cancel_task`/`pause_task`/`resume_task`, `create_agent`,
`ask_user_question`, `send_card`, `install_packages`, `add_mcp_server`, …)
is untouched and stays deferred behind `ToolSearch`, same as before.

**Rejected alternative — server-level `alwaysLoad`:** `McpStdioServerConfig`
(the type nanoclaw's `mcpServers.nanoclaw` entry in `claude.ts` actually
uses) also has a server-level `alwaysLoad?: boolean` — but that's
all-or-nothing for every tool on the server, which would defeat the point.
Not used.

## Why it's safe

- Zero change to `claude.ts`/`TOOL_ALLOWLIST`/`mcpServers` wiring — the
  whole fix lives in the 4 tool definitions in `core.ts`.
- Zero change to the other ~11 nanoclaw tools — still deferred, still
  discoverable only via `ToolSearch` exactly as before.
- Measured cost (real BPE tokenizer over the 4 tools' actual JSON schemas,
  not a char/4 guess): **~361 tokens** added to the eager tool block.
  Before this patch these 4 schemas contributed ~0 tokens to the steady-state
  prompt (excluded entirely while deferred); after, ~361 tokens, paid once
  per prompt-cache lifetime as part of the static system-prompt prefix, not
  per turn.
- Live-verified on the real send path (Terminal Agent / `cli-with-robby`,
  already configured for `claude-sonnet-5`): a Bash-tool-call-plus-reply turn
  and a final-confirmation turn both delivered via `send_message` directly —
  zero `ToolSearch select:…send_message` calls in container logs. A
  `schedule_task` + `cancel_task` turn (rare tools) correctly triggered
  `🔧 toolsearch select:mcp__nanoclaw__schedule_task` /
  `…cancel_task` — confirming the selective split actually holds in
  practice, not just in theory.
- `container/agent-runner/src` is volume-mounted read-only into the
  container at spawn time (`container-runner.ts:359-361`) — this change
  takes effect on the **next container spawn/restart**, no image rebuild
  required (unlike patches that touch `cli-tools.json` / baked
  `node_modules`).

## Verify

`grep -c "anthropic/alwaysLoad" container/agent-runner/src/mcp-tools/core.ts`
should be 4 (see `verify.sh`). Typecheck:
`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

## Re-apply after upstream reset

Add `_meta: { 'anthropic/alwaysLoad': true }` to the `tool` object of each of
`sendMessage`, `sendFile`, `editMessage`, `addReaction` in
`container/agent-runner/src/mcp-tools/core.ts`. No other file changes.
