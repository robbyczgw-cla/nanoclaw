#!/usr/bin/env python3
"""Apply v0.x tool-visibility improvements to nanoclaw-v2.

Adds:
- domainOf() helper for URL → domain extraction
- shortPath() helper for "..." -prefixed path shortening
- TodoWrite count description
- Verb-alignment via padEnd(8) for vertical scanning
"""

path = 'container/agent-runner/src/hooks/tool-visibility.ts'
src = open(path).read()

# 1. Add helper functions after `truncate()` definition
old_truncate_end = """function truncate(s: string): string {
  return s.length > MAX_INPUT_PREVIEW ? s.slice(0, MAX_INPUT_PREVIEW) + '…' : s;
}"""

new_helpers = """function truncate(s: string): string {
  return s.length > MAX_INPUT_PREVIEW ? s.slice(0, MAX_INPUT_PREVIEW) + '…' : s;
}

/** Extract domain from URL — keeps preview compact ("github.com" not full URL). */
function domainOf(url: string): string {
  return url.replace(/^https?:\\/\\//, '').split('/')[0];
}

/** Shorten long file paths from the start with an ellipsis prefix. */
function shortPath(p: string, maxLen = 35): string {
  if (p.length <= maxLen) return p;
  return '…' + p.slice(-(maxLen - 1));
}

/** Format a tool message with verb-aligned label for easier scanning. */
function formatToolLine(emoji: string, label: string, desc: string, count = 0): string {
  const countStr = count > 1 ? ` ×${count}` : '';
  // Pad label so descriptions align vertically across tool calls.
  const paddedLabel = label.padEnd(8);
  return desc ? `${emoji} ${paddedLabel}${countStr} ${desc}`.trimEnd()
              : `${emoji} ${paddedLabel.trimEnd()}${countStr}`;
}"""

if old_truncate_end not in src:
    print('ERROR: truncate end anchor not found')
    raise SystemExit(1)
src = src.replace(old_truncate_end, new_helpers, 1)

# 2. Update describeToolInput to use shortPath/domainOf and handle TodoWrite count
old_describe = """  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path;
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    return truncate(input.url);
  }
  if (toolName === 'WebSearch' && typeof input.query === 'string') {
    return truncate(input.query);
  }
  if (toolName === 'Task' && typeof input.description === 'string') {
    return truncate(input.description);
  }"""

new_describe = """  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
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

if old_describe not in src:
    print('ERROR: describeToolInput anchor not found')
    raise SystemExit(1)
src = src.replace(old_describe, new_describe, 1)

# 3. Update flushBatch to use formatToolLine
old_flush = """function flushBatch(toolName: string): void {
  const entry = toolBatch.get(toolName);
  if (!entry) return;
  toolBatch.delete(toolName);
  const suffix = entry.lastDesc ? `: ${entry.lastDesc}` : '';
  const countStr = entry.count > 1 ? ` ×${entry.count}` : '';
  emit(`${entry.emoji} ${entry.label}${countStr}${suffix}`);
}"""

new_flush = """function flushBatch(toolName: string): void {
  const entry = toolBatch.get(toolName);
  if (!entry) return;
  toolBatch.delete(toolName);
  emit(formatToolLine(entry.emoji, entry.label, entry.lastDesc, entry.count));
}"""

if old_flush not in src:
    print('ERROR: flushBatch anchor not found')
    raise SystemExit(1)
src = src.replace(old_flush, new_flush, 1)

# 4. Update preToolUseVisibility format
old_pre_emit = """  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    const text = desc ? `${emoji} ${label}: ${desc}` : `${emoji} ${label}`;
    emit(text);
  }"""

new_pre_emit = """  if (BATCH_TOOLS.has(toolName)) {
    sendBatched(toolName, emoji, label, desc);
  } else {
    emit(formatToolLine(emoji, label, desc));
  }"""

if old_pre_emit not in src:
    print('ERROR: pre-emit anchor not found')
    raise SystemExit(1)
src = src.replace(old_pre_emit, new_pre_emit, 1)

# 5. Update post-hook bash done message
old_post = """    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      emit(`🖥️ bash: done in ${(elapsed / 1000).toFixed(1)}s`);
    }"""

new_post = """    if (elapsed > LONG_CALL_THRESHOLD_MS) {
      emit(formatToolLine('🖥️', 'bash', `done in ${(elapsed / 1000).toFixed(1)}s`));
    }"""

if old_post not in src:
    print('ERROR: post-hook anchor not found')
    raise SystemExit(1)
src = src.replace(old_post, new_post, 1)

open(path, 'w').write(src)
print('OK — patch applied')
print(f'New file size: {len(src)} chars')
