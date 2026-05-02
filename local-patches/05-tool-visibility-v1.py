#!/usr/bin/env python3
"""Apply v1.0a/b/c tool-visibility improvements:
- v1.0a: bash output first-line preview alongside line count
- v1.0b: code-fence paths/commands/queries for Telegram readability
- v1.0c: iteration progress emit for long-running Agent/Task calls
"""

path = 'container/agent-runner/src/hooks/tool-visibility.ts'
src = open(path).read()


# ─── v1.0a: bash output first-line preview ───────────────────────────

old_result_shape = """function resultShape(toolName: string, toolResponse: unknown): string | null {
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
}"""

new_result_shape = """function resultShape(toolName: string, toolResponse: unknown): string | null {
  const text = extractResponseText(toolResponse);
  if (toolName === 'Read' && text) {
    const lines = text.split('\\n').length;
    return `${lines} lines`;
  }
  if (toolName === 'Bash' && text) {
    const allLines = text.split('\\n');
    const nonEmpty = allLines.filter((l) => l.trim()).length;
    if (nonEmpty < 1) return null;
    // Show first non-empty line as a sneak-peek; useful confirmation that
    // the command actually produced what was expected. Trim to keep the
    // chat-line compact.
    const firstLine = allLines.find((l) => l.trim()) || '';
    const peek = firstLine.replace(/\\s+/g, ' ').trim().slice(0, 60);
    if (nonEmpty >= 5) {
      return peek ? `${nonEmpty} lines  → \\`${peek}\\`` : `${nonEmpty} lines`;
    }
    if (peek) return `→ \\`${peek}\\``;
    return null;
  }
  if (toolName === 'WebFetch' && text) {
    const kb = Math.round(text.length / 1024);
    if (kb >= 1) return `${kb}KB`;
    return null;
  }
  return null;
}"""

if old_result_shape not in src:
    print('ERROR: resultShape anchor not found')
    raise SystemExit(1)
src = src.replace(old_result_shape, new_result_shape, 1)
print('✅ v1.0a: bash first-line preview added')


# ─── v1.0b: code-fence paths/commands ─────────────────────────────────

# Wrap the returned values in backticks for tools where desc is a
# path/cmd/query/url. Telegram's MarkdownV1 renders backticks as monospace
# inline code → distinct visual treatment, mobile-readable.
old_describe = """  if (toolName === 'Bash' && typeof input.command === 'string') {
    return summarizeBash(input.command);
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
    return shortPath(input.file_path);
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return domainOf(input.url);
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `"${truncate(input.query)}"`;
  }
  if (toolName === 'Task' && typeof input.description === 'string') {
    return truncate(input.description);
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const n = input.todos.length;
    return `${n} task${n === 1 ? '' : 's'}`;
  }"""

new_describe = """  if (toolName === 'Bash' && typeof input.command === 'string') {
    return `\\`${summarizeBash(input.command)}\\``;
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && typeof input.file_path === 'string') {
    return `\\`${shortPath(input.file_path)}\\``;
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return `\\`${input.pattern}\\``;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return `\\`${input.pattern}\\``;
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return `\\`${domainOf(input.url)}\\``;
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return `\\`${truncate(input.query)}\\``;
  }
  if (toolName === 'Task' && typeof input.description === 'string') {
    return truncate(input.description);
  }
  if (toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const n = input.todos.length;
    return `${n} task${n === 1 ? '' : 's'}`;
  }"""

if old_describe not in src:
    print('ERROR: describeToolInput anchor not found')
    raise SystemExit(1)
src = src.replace(old_describe, new_describe, 1)
print('✅ v1.0b: code-fence values for paths/cmds/patterns/urls/queries')


# ─── v1.0c: iteration progress for Agent/Task ─────────────────────────

# Add a setInterval-based progress emitter for long-running Agent/Task
# tool calls. Started on pre-tool, cleared on post-tool. Emits a
# "⏳ task  still working — Xs elapsed" line every 30s as long as the
# call hasn't returned.

old_long_threshold = """const LONG_CALL_THRESHOLD_MS = 3000;"""
new_long_threshold = """const LONG_CALL_THRESHOLD_MS = 3000;
const PROGRESS_FIRST_DELAY_MS = 30000;  // first progress msg at 30s
const PROGRESS_INTERVAL_MS = 30000;     // then every 30s"""

if old_long_threshold not in src:
    print('ERROR: LONG_CALL_THRESHOLD anchor not found')
    raise SystemExit(1)
src = src.replace(old_long_threshold, new_long_threshold, 1)

# Add progress timer registry near toolStartTimes
old_start_times = """const toolStartTimes: Record<string, number> = {};"""
new_start_times = """const toolStartTimes: Record<string, number> = {};
const progressTimers: Record<string, ReturnType<typeof setInterval>> = {};"""

if old_start_times not in src:
    print('ERROR: toolStartTimes anchor not found')
    raise SystemExit(1)
src = src.replace(old_start_times, new_start_times, 1)

# Hook into pre-tool: start progress timer for Agent/Task
old_pre_emit = """  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    emit(formatToolLine(emoji, label, desc));
  }

  return { continue: true };
};"""

new_pre_emit = """  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    emit(formatToolLine(emoji, label, desc));
  }

  // Progress emitter for long-running Agent/Task calls — sends a
  // "still working — Xs elapsed" message every 30s while the call hasn't
  // returned. Cleared in the post-tool hook.
  if ((toolName === 'Agent' || toolName === 'Task') && id) {
    const startedAt = toolStartTimes[id] ?? Date.now();
    const tick = () => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      const elapsedStr = elapsedSec >= 60
        ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
        : `${elapsedSec}s`;
      emit(formatToolLine('⏳', label, `still working — ${elapsedStr} elapsed`));
    };
    progressTimers[id] = setInterval(tick, PROGRESS_INTERVAL_MS);
    // First tick after 30s (don't fire immediately — pre-hook line already shown)
    setTimeout(tick, PROGRESS_FIRST_DELAY_MS);
  }

  return { continue: true };
};"""

if old_pre_emit not in src:
    print('ERROR: pre-emit anchor not found')
    raise SystemExit(1)
src = src.replace(old_pre_emit, new_pre_emit, 1)

# Hook into post-tool: clear progress timer
old_post_clear = """  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();"""

new_post_clear = """  const id = toolUseId || i.tool_use_id;
  const startTime = id ? toolStartTimes[id] : undefined;
  if (id) delete toolStartTimes[id];

  // Clear any progress timer for Agent/Task — call is done, no more ticks.
  if (id && progressTimers[id]) {
    clearInterval(progressTimers[id]);
    delete progressTimers[id];
  }

  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();"""

if old_post_clear not in src:
    print('ERROR: post-clear anchor not found')
    raise SystemExit(1)
src = src.replace(old_post_clear, new_post_clear, 1)
print('✅ v1.0c: iteration progress timer for Agent/Task')


open(path, 'w').write(src)
print(f'\\nDone. New file size: {len(src)} chars')
