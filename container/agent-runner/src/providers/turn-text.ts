/**
 * Turn-text accumulation for the SDK event stream (PATCH 11).
 *
 * BUG: the runner dispatched `<message to="...">` blocks from the SDK
 * `result.result` field only — and that field is just the FINAL assistant text
 * of a turn. On long tool-use chains the model often emits its `<message>` reply
 * and THEN makes another tool call (e.g. a final verification), so
 * `result.result` ends up being the short post-tool text and the earlier
 * `<message>` block was never scanned → the reply vanished silently. The
 * `send_message` MCP path was unaffected because it writes immediately.
 *
 * FIX: accumulate every MAIN-agent assistant text block across the turn and
 * dispatch from that superset, falling back to `result.result` only when no
 * assistant text was captured.
 *
 * These are pure helpers so the regression is unit-testable without the SDK.
 */

export interface AssistantLikeMessage {
  type: string;
  parent_tool_use_id?: string | null;
  message?: { content?: Array<{ type: string; text?: string }> };
}

/**
 * Text of a MAIN-agent assistant message. Empty for non-assistant messages,
 * for sub-agent (Task tool) messages (`parent_tool_use_id` set), and for
 * tool-only content. Matches what `result.result` would have surfaced — but for
 * EVERY assistant step, not just the last.
 */
export function extractMainAgentText(message: AssistantLikeMessage): string {
  if (message.type !== 'assistant') return '';
  if (message.parent_tool_use_id != null) return ''; // sub-agent (Task) — not ours
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/** Append a chunk to the running turn buffer, newline-joined. */
export function appendTurnText(buffer: string, chunk: string): string {
  if (!chunk) return buffer;
  return buffer ? `${buffer}\n${chunk}` : chunk;
}

/**
 * Choose the text to dispatch for a completed turn: the full accumulated
 * main-agent text when present (catches pre-tool `<message>` blocks), else the
 * SDK `result.result` fallback.
 */
export function resolveTurnDispatchText(turnText: string, resultText: string | null): string | null {
  return turnText.length > 0 ? turnText : resultText;
}

/**
 * Count `<message ...>` opening tags in text. Used by the loud-fail guard to
 * detect message-shaped blocks that were NOT enqueued (e.g. malformed/unclosed),
 * so silent vanishing becomes a logged warning.
 */
export function countMessageOpenTags(text: string): number {
  return (text.match(/<message\b[^>]*>/g) ?? []).length;
}
