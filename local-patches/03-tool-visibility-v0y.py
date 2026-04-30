#!/usr/bin/env python3
"""Apply v0.y tool-visibility improvements to nanoclaw-v2.

Builds on v0.x. Adds:
- Failure detection (PostToolUseFailure event + heuristic from response)
- Result-shape feedback (Bash + Read line counts; WebFetch size)
- Edit/Write emoji differentiation (Edit ✏️ stays; Write becomes ✍️)
"""

path = 'container/agent-runner/src/hooks/tool-visibility.ts'
src = open(path).read()

# 1. Differentiate Write emoji from Edit.
old_emoji_block = """const TOOL_EMOJI: Record<string, string> = {
  Bash: '🖥️',
  Read: '📖',
  Write: '✏️',
  Edit: '✏️',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
  TodoWrite: '📝',
};"""

new_emoji_block = """const TOOL_EMOJI: Record<string, string> = {
  Bash: '🖥️',
  Read: '📖',
  Write: '✍️',
  Edit: '✏️',
  MultiEdit: '✏️',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Agent: '🤖',
  Task: '🤖',
  TodoWrite: '📝',
};"""

if old_emoji_block not in src:
    print('ERROR: TOOL_EMOJI anchor not found')
    raise SystemExit(1)
src = src.replace(old_emoji_block, new_emoji_block, 1)

# 2. Add MultiEdit label too.
old_label_block = """const TOOL_LABEL: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  WebFetch: 'fetch',
  WebSearch: 'search',
  Agent: 'agent',
  Task: 'task',
  TodoWrite: 'todo',
};"""

new_label_block = """const TOOL_LABEL: Record<string, string> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  WebFetch: 'fetch',
  WebSearch: 'search',
  Agent: 'agent',
  Task: 'task',
  TodoWrite: 'todo',
};"""

if old_label_block not in src:
    print('ERROR: TOOL_LABEL anchor not found')
    raise SystemExit(1)
src = src.replace(old_label_block, new_label_block, 1)

# 3. Add MultiEdit to BATCH_TOOLS too.
old_batch = "const BATCH_TOOLS = new Set(['Read', 'Write', 'Edit', 'WebFetch']);"
new_batch = "const BATCH_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'WebFetch']);"
if old_batch not in src:
    print('ERROR: BATCH_TOOLS anchor not found')
    raise SystemExit(1)
src = src.replace(old_batch, new_batch, 1)

# 4. Insert result-shape + failure-detection helpers AFTER formatToolLine.
old_format_end = """function formatToolLine(emoji: string, label: string, desc: string, count = 0): string {
  const countStr = count > 1 ? ` ×${count}` : '';
  // Pad label so descriptions align vertically across tool calls.
  const paddedLabel = label.padEnd(8);
  return desc ? `${emoji} ${paddedLabel}${countStr} ${desc}`.trimEnd()
              : `${emoji} ${paddedLabel.trimEnd()}${countStr}`;
}"""

new_helpers_y = """function formatToolLine(emoji: string, label: string, desc: string, count = 0): string {
  const countStr = count > 1 ? ` ×${count}` : '';
  // Pad label so descriptions align vertically across tool calls.
  const paddedLabel = label.padEnd(8);
  return desc ? `${emoji} ${paddedLabel}${countStr} ${desc}`.trimEnd()
              : `${emoji} ${paddedLabel.trimEnd()}${countStr}`;
}

/**
 * Try to extract a string output from a tool_response of unknown shape.
 * Returns null if nothing string-y is found.
 */
function extractResponseText(toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.output === 'string') return r.output;
    if (typeof r.text === 'string') return r.text;
    if (typeof r.content === 'string') return r.content;
    if (typeof r.stdout === 'string') return r.stdout;
  }
  return null;
}

/**
 * Compact post-completion result hint — line counts, response sizes, exit codes.
 * Returns null when there's nothing interesting to add (avoids chat spam).
 */
function resultShape(toolName: string, toolResponse: unknown): string | null {
  const text = extractResponseText(toolResponse);
  if (toolName === 'Read' && text) {
    const lines = text.split('\\n').length;
    return `${lines} lines`;
  }
  if (toolName === 'Bash' && text) {
    const nonEmpty = text.split('\\n').filter((l) => l.trim()).length;
    if (nonEmpty >= 5) return `${nonEmpty} lines`;
    return null;
  }
  if (toolName === 'WebFetch' && text) {
    const kb = Math.round(text.length / 1024);
    if (kb >= 1) return `${kb}KB`;
    return null;
  }
  return null;
}

/**
 * Heuristic failure detection from a normal PostToolUse response. Some tools
 * report errors via the response payload rather than throwing — this catches
 * those so we still emit the ❌ marker.
 */
function detectFailureFromResponse(_toolName: string, toolResponse: unknown): string | null {
  if (toolResponse == null) return null;
  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (r.is_error === true || r.success === false) {
      const explicit = typeof r.error === 'string' ? r.error
        : typeof r.message === 'string' ? r.message
        : 'failed';
      return explicit.replace(/\\s+/g, ' ').trim().slice(0, 80);
    }
    if (typeof r.error === 'string' && r.error.trim()) {
      return r.error.replace(/\\s+/g, ' ').trim().slice(0, 80);
    }
  }
  const text = extractResponseText(toolResponse);
  if (!text) return null;
  // Pattern-based fallback. Conservative — only flag clear failures.
  const patterns: RegExp[] = [
    /^(Error|ERROR): (.+)$/m,
    /(permission denied)/i,
    /(no such file or directory)/i,
    /(command not found)/i,
    /(Traceback \\(most recent call last\\))/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].replace(/\\s+/g, ' ').trim().slice(0, 80);
  }
  return null;
}"""

if old_format_end not in src:
    print('ERROR: formatToolLine anchor not found')
    raise SystemExit(1)
src = src.replace(old_format_end, new_helpers_y, 1)

# 5. Rewrite postToolUseVisibility to handle failure + result-shape.
old_post_hook = """export const postToolUseVisibility: HookCallback = async (input, toolUseId) => {
  const i = input as { tool_name?: string; tool_use_id?: string; transcript_path?: string };
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  if (toolName === 'Bash' && startTime) {
    const elapsed = Date.now() - startTime;
    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      emit(formatToolLine('🖥️', 'bash', `done in ${(elapsed / 1000).toFixed(1)}s`));
    }
  }

  return { continue: true };
};"""

new_post_hook = """export const postToolUseVisibility: HookCallback = async (input, toolUseId) => {
  const i = input as {
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_response?: unknown;
    error?: string;
    tool_use_id?: string;
    transcript_path?: string;
  };
  if (typeof i.transcript_path === 'string' && i.transcript_path.includes('/subagents/')) {
    return { continue: true };
  }
  const toolName = i.tool_name ?? '';

  if (SKIP_TOOLS.has(toolName)) return { continue: true };

  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();
  const desc = describeToolInput(toolName, i.tool_input);

  // FAILURE PATH 1 — explicit PostToolUseFailure event with `error` field.
  if (i.hook_event_name === 'PostToolUseFailure') {
    const reason = (i.error ?? 'failed').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const merged = desc ? `${desc}  ✗ ${reason}` : `✗ ${reason}`;
    emit(formatToolLine('❌', label, merged));
    return { continue: true };
  }

  // FAILURE PATH 2 — heuristic detection from tool_response (some tools
  // report errors in their normal response payload).
  const inferred = detectFailureFromResponse(toolName, i.tool_response);
  if (inferred) {
    const merged = desc ? `${desc}  ✗ ${inferred}` : `✗ ${inferred}`;
    emit(formatToolLine('❌', label, merged));
    return { continue: true };
  }

  // SUCCESS PATH — emit done-marker for slow Bash, optionally enriched
  // with a result-shape hint (line count, response size).
  if (toolName === 'Bash' && startTime) {
    const elapsed = Date.now() - startTime;
    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      const shape = resultShape(toolName, i.tool_response);
      const elapsedStr = `done in ${(elapsed / 1000).toFixed(1)}s`;
      const finalDesc = shape ? `${elapsedStr}  ${shape}` : elapsedStr;
      emit(formatToolLine('🖥️', 'bash', finalDesc));
    }
  }

  return { continue: true };
};"""

if old_post_hook not in src:
    print('ERROR: postToolUseVisibility anchor not found')
    raise SystemExit(1)
src = src.replace(old_post_hook, new_post_hook, 1)

open(path, 'w').write(src)
print('OK — v0.y patch applied')
print(f'New file size: {len(src)} chars')
