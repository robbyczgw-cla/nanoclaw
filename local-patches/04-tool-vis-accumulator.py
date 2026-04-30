#!/usr/bin/env python3
"""Apply v0.z tool-visibility accumulator pattern to nanoclaw-v2.

Two changes:
1. tool-visibility.ts: `emit()` adds `_toolVis: true` flag to outbound content
2. chat-sdk-bridge.ts: bridge intercepts _toolVis messages, accumulates into
   a single message-bubble per thread by editing rather than sending new

Result: 6 tool calls in a turn → 1 chat bubble that grows in-place,
not 6 separate Telegram notifications.

Telegram-only: relies on adapter.editMessage support. Other channels fall
back to fresh sends when edit fails.
"""

# ─── Patch 1: tool-visibility.ts emit() flag ─────────────────────────

vis_path = 'container/agent-runner/src/hooks/tool-visibility.ts'
vis_src = open(vis_path).read()

old_emit = """function emit(text: string): void {
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) {
      // Agent-shared or internal session with no reply lane — nothing to do.
      return;
    }
    writeMessageOut({
      id: `tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });
  } catch (err) {
    log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}"""

new_emit = """function emit(text: string): void {
  try {
    const routing = getSessionRouting();
    if (!routing.channel_type || !routing.platform_id) {
      // Agent-shared or internal session with no reply lane — nothing to do.
      return;
    }
    writeMessageOut({
      id: `tv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      // Mark as tool-visibility so the chat-sdk-bridge accumulates these
      // into a single edited message-bubble per thread (Telegram-style),
      // rather than sending a new notification per tool call.
      content: JSON.stringify({ text, _toolVis: true }),
    });
  } catch (err) {
    log(`emit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}"""

if old_emit not in vis_src:
    print('ERROR: emit() anchor not found in tool-visibility.ts')
    raise SystemExit(1)

vis_src = vis_src.replace(old_emit, new_emit, 1)
open(vis_path, 'w').write(vis_src)
print(f'✅ tool-visibility.ts patched: {len(vis_src)} chars')


# ─── Patch 2: chat-sdk-bridge.ts accumulator ─────────────────────────

bridge_path = 'src/channels/chat-sdk-bridge.ts'
bridge_src = open(bridge_path).read()

# 2a. Insert accumulator state + helper near the top of createChatSdkBridge.
# Anchor: just inside the function, before the first existing setup line.
# We'll anchor on a comment near the start of returned object.

old_deliver_open = """    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;

      if (content.operation === 'edit' && content.messageId) {"""

new_deliver_open = """    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;

      // ── Tool-visibility accumulator ──────────────────────────────────
      // Tool-call previews carry `_toolVis: true` (set by the agent
      // container's tool-visibility hook). We accumulate these into a
      // single message-bubble per thread by editing the original send
      // rather than emitting a new notification per tool call.
      const accumKey = `${tid}:tool-vis`;
      if (content._toolVis === true) {
        const lineText = (content.text as string) || '';
        if (!lineText) return;
        return await deliverToolVisAccumulator(tid, lineText, accumKey);
      }
      // Non-tool-vis message → close any open accumulator for this thread
      // so the agent's actual answer renders as a separate bubble.
      toolVisAccumulators.delete(accumKey);

      if (content.operation === 'edit' && content.messageId) {"""

if old_deliver_open not in bridge_src:
    print('ERROR: deliver-open anchor not found in chat-sdk-bridge.ts')
    raise SystemExit(1)
bridge_src = bridge_src.replace(old_deliver_open, new_deliver_open, 1)

# 2b. Insert the accumulator state + helper function inside createChatSdkBridge.
# Anchor: after the `botUsernamePromise` line just before any returned object setup.
# Easier anchor: insert right before the `return {` that opens the returned adapter.

# Find the `return {` that starts the returned object — there might be multiple
# in the file, so anchor on a more unique nearby context.
old_return_anchor = """      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },"""

new_return_anchor = """      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    deliverToolVis: undefined,"""

# Actually, we need a different approach. The state needs to live in closure scope,
# not on the returned object. Let's insert it at the top of createChatSdkBridge.

# Anchor on the very start of the function body — right after the function opening.
old_bridge_open = """export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {"""

new_bridge_open = """interface ToolVisAccumulator {
  messageId: string;
  lines: string[];
  combinedLength: number;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  // In-memory map of open tool-visibility accumulators. Keyed by `${tid}:tool-vis`.
  // Each entry tracks the original message_id + accumulated lines so we can
  // edit-in-place rather than emit a new message per tool call.
  // Cleared on the next non-tool-vis message to that thread (the agent's
  // actual answer flushes the accumulator).
  const toolVisAccumulators = new Map<string, ToolVisAccumulator>();

  // Send a tool-visibility line into an accumulator. First line for a key
  // creates a new message; subsequent lines edit that message in-place.
  // Falls back to a fresh send if edit fails (rate limit, message gone,
  // adapter doesn't support edit on this platform).
  async function deliverToolVisAccumulator(
    tid: string,
    lineText: string,
    accumKey: string,
  ): Promise<string | undefined> {
    const transformed = transformText(lineText);
    const existing = toolVisAccumulators.get(accumKey);

    if (!existing) {
      // First emit for this accumulator — send fresh and remember the id.
      const result = await adapter.postMessage(tid, { markdown: transformed });
      const id = result?.id;
      if (id) {
        toolVisAccumulators.set(accumKey, {
          messageId: id,
          lines: [lineText],
          combinedLength: lineText.length,
        });
      }
      return id;
    }

    // Length guard — if the next line would push past the adapter's limit,
    // close out the current accumulator and start a fresh one rather than
    // truncating mid-call. Cheaper than tracking edits across split chunks.
    const projected = existing.combinedLength + 1 + lineText.length;
    if (config.maxTextLength && projected > config.maxTextLength) {
      const result = await adapter.postMessage(tid, { markdown: transformed });
      const id = result?.id;
      if (id) {
        toolVisAccumulators.set(accumKey, {
          messageId: id,
          lines: [lineText],
          combinedLength: lineText.length,
        });
      }
      return id;
    }

    // Edit the existing message with the combined text.
    const combinedRaw = existing.lines.concat(lineText).join('\\n');
    try {
      await adapter.editMessage(tid, existing.messageId, {
        markdown: transformText(combinedRaw),
      });
      existing.lines.push(lineText);
      existing.combinedLength = combinedRaw.length;
      return existing.messageId;
    } catch (err) {
      // Edit failed — could be rate-limit, message-deleted, adapter without
      // edit support, or unchanged-content. Fall back to a fresh send and
      // restart the accumulator at this line.
      log.warn('Tool-vis edit failed, falling back to fresh send', {
        err: err instanceof Error ? err.message : String(err),
        adapter: adapter.name,
      });
      const result = await adapter.postMessage(tid, { markdown: transformed });
      const id = result?.id;
      if (id) {
        toolVisAccumulators.set(accumKey, {
          messageId: id,
          lines: [lineText],
          combinedLength: lineText.length,
        });
      } else {
        toolVisAccumulators.delete(accumKey);
      }
      return id;
    }
  }
"""

if old_bridge_open not in bridge_src:
    print('ERROR: createChatSdkBridge open anchor not found')
    raise SystemExit(1)
bridge_src = bridge_src.replace(old_bridge_open, new_bridge_open, 1)

# Revert the accidental "deliverToolVis: undefined" placeholder we tried before.
bridge_src = bridge_src.replace(
    """      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    deliverToolVis: undefined,""",
    """      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },""",
    1,
)

open(bridge_path, 'w').write(bridge_src)
print(f'✅ chat-sdk-bridge.ts patched: {len(bridge_src)} chars')

print('Done.')
