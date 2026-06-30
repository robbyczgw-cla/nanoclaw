#!/bin/bash
# verify.sh — checks all local patches are present in /root/nanoclaw-v2/.
#
# Usage: bash local-patches/verify.sh
# Exit 0 if all patches are applied. Exit 1 otherwise.

set -u
cd /root/nanoclaw-v2

ALL_OK=true

# Patch 01 — telegram maxTextLength
if grep -q 'maxTextLength: 4000' src/channels/telegram.ts 2>/dev/null; then
  echo "✅ 01-telegram-maxtextlength applied"
else
  echo "❌ 01-telegram-maxtextlength MISSING"
  ALL_OK=false
fi

# Patch 02 — tool-visibility v0.x (anchor: formatToolLine helper)
if grep -q 'function formatToolLine' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 02-tool-visibility-v0x applied"
else
  echo "❌ 02-tool-visibility-v0x MISSING"
  ALL_OK=false
fi

# Patch 03 — tool-visibility v0.y (anchor: detectFailureFromResponse helper)
if grep -q 'function detectFailureFromResponse' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 03-tool-visibility-v0y applied"
else
  echo "❌ 03-tool-visibility-v0y MISSING"
  ALL_OK=false
fi

# Patch 04 — tool-vis accumulator (hook flag + bridge accumulator)
if grep -q '_toolVis: true' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null    && grep -q 'toolVisAccumulators' src/channels/chat-sdk-bridge.ts 2>/dev/null; then
  echo "✅ 04-tool-vis-accumulator applied"
else
  echo "❌ 04-tool-vis-accumulator MISSING (or partial — check both hook + bridge)"
  ALL_OK=false
fi


# Patch 05 — tool-visibility v1.0 (bash preview + code-fence + iteration progress)
if grep -q 'progressTimers' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null    && grep -q 'PROGRESS_INTERVAL_MS' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 05-tool-visibility-v1 applied"
else
  echo "❌ 05-tool-visibility-v1 MISSING"
  ALL_OK=false
fi

# Patch 06 — tool-visibility v1.1 (bash-prefix + task-suppress + cache-fix)
if grep -q 'function isTaskSession' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null \
   && grep -q 'isPureAssignment' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null \
   && grep -q 'if (isTaskSession()) return' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 06-tool-visibility-v1.1 applied"
else
  echo "❌ 06-tool-visibility-v1.1 MISSING (or partial — check isTaskSession + isPureAssignment + emit guard)"
  ALL_OK=false
fi

echo

# Patch 07 — empty TodoWrite suppress (anchor: comment + early-return)
if grep -q "Patch 07 — suppress empty TodoWrite" container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 07-empty-todowrite-suppress applied"
else
  echo "❌ 07-empty-todowrite-suppress MISSING"
  ALL_OK=false
fi

# Patch 08 — telegram caption chunking + per-chat outbound queue
if grep -q 'maxCaptionLength: 1000' src/channels/telegram.ts 2>/dev/null    && grep -q 'enqueueOutbound' src/channels/chat-sdk-bridge.ts 2>/dev/null    && grep -q 'PATCH08_CLOSE_DELIVER' src/channels/chat-sdk-bridge.ts 2>/dev/null; then
  echo "✅ 08-telegram-caption-and-burst applied"
else
  echo "❌ 08-telegram-caption-and-burst MISSING (or partial)"
  ALL_OK=false
fi

# Patch 09 — tool-vis edit coalescing (debounced bubble edits + finalize flush)
if grep -q 'TOOL_VIS_EDIT_THROTTLE_MS' src/channels/chat-sdk-bridge.ts 2>/dev/null \
   && grep -q 'function finalizeToolVis' src/channels/chat-sdk-bridge.ts 2>/dev/null \
   && grep -q 'function flushToolVis' src/channels/chat-sdk-bridge.ts 2>/dev/null; then
  echo "✅ 09-tool-vis-edit-coalescing applied"
else
  echo "❌ 09-tool-vis-edit-coalescing MISSING (or partial — check throttle const + flush/finalize)"
  ALL_OK=false
fi

# Patch 10 — tool-vis task-session fix (classify on current processing batch)
if grep -q "processing_ack WHERE status = 'processing'" container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null \
   && grep -q 'PATCH 10' container/agent-runner/src/hooks/tool-visibility.ts 2>/dev/null; then
  echo "✅ 10-tool-vis-task-session-fix applied"
else
  echo "❌ 10-tool-vis-task-session-fix MISSING"
  ALL_OK=false
fi

# Patch 11 — <message> block enqueue fix (dispatch full turn text)
# (poll-loop's guard symbol was superseded by patch 12's countMessageBlockOpenTags;
#  anchor on the stable turn-text-accumulation symbols instead.)
if grep -q 'resolveTurnDispatchText' container/agent-runner/src/providers/claude.ts 2>/dev/null \
   && grep -q 'extractMainAgentText' container/agent-runner/src/providers/turn-text.ts 2>/dev/null \
   && grep -q 'appendTurnText' container/agent-runner/src/providers/claude.ts 2>/dev/null; then
  echo "✅ 11-message-block-enqueue-fix applied"
else
  echo "❌ 11-message-block-enqueue-fix MISSING (or partial — check claude.ts + turn-text.ts + poll-loop.ts)"
  ALL_OK=false
fi

# Patch 12 — turn-stall fix (tolerant parse + capped in-turn re-prompt)
# (anchor on stable symbols; patch 13 rewrote the closing-tag regex.)
if grep -q 'parseMessageBlocks' container/agent-runner/src/message-blocks.ts 2>/dev/null \
   && grep -q 'buildRewrapReminder' container/agent-runner/src/message-blocks.ts 2>/dev/null \
   && grep -q 'MAX_UNWRAPPED_RETRIES' container/agent-runner/src/poll-loop.ts 2>/dev/null; then
  echo "✅ 12-turn-stall-rejected-response applied"
else
  echo "❌ 12-turn-stall-rejected-response MISSING (or partial — check message-blocks.ts + poll-loop.ts)"
  ALL_OK=false
fi

# Patch 13 — tolerant parse tail-strip (no mid-body cut)
if grep -q 'TRAILING_STRAY_CLOSE' container/agent-runner/src/message-blocks.ts 2>/dev/null; then
  echo "✅ 13-message-tag-tail-strip applied"
else
  echo "❌ 13-message-tag-tail-strip MISSING"
  ALL_OK=false
fi

# Patch 14 — /learn available as a runtime skill in agent containers
if grep -q '^name: learn' container/skills/learn/SKILL.md 2>/dev/null; then
  echo "✅ 14-learn-container-skill applied"
else
  echo "❌ 14-learn-container-skill MISSING"
  ALL_OK=false
fi

# Patch 15 — claude.ts local default model (opus-4-8) + auto-compact window (900k)
if grep -q "ANTHROPIC_MODEL ?? 'claude-opus-4-8'" container/agent-runner/src/providers/claude.ts 2>/dev/null \
   && grep -q "|| '900000'" container/agent-runner/src/providers/claude.ts 2>/dev/null; then
  echo "✅ 15-claude-default-model-and-compact-window applied"
else
  echo "❌ 15-claude-default-model-and-compact-window MISSING (or partial — check model fallback + compact window)"
  ALL_OK=false
fi

# Patch 16 — native Telegram tables via Bot API 10.1 sendRichMessage
if grep -q 'sendRichMessageRaw' src/channels/telegram.ts 2>/dev/null \
   && [ -f src/channels/telegram-rich-message.ts ]; then
  echo "✅ 16-telegram-rich-tables applied"
else
  echo "❌ 16-telegram-rich-tables MISSING"
  ALL_OK=false
fi

# Patch 17 — collapse tool-vis timeline into a <details> fold
if grep -q 'editRichMessageRaw' src/channels/telegram-rich-message.ts 2>/dev/null && grep -q 'collapseToolVis' src/channels/chat-sdk-bridge.ts 2>/dev/null; then
  echo "✅ 17-toolvis-collapse-fold applied"
else
  echo "❌ 17-toolvis-collapse-fold MISSING"
  ALL_OK=false
fi

# Patch 18 — broaden rich routing to MarkdownV2-impossible constructs
if grep -q 'hasRichOnlyConstruct' src/channels/telegram-rich-message.ts 2>/dev/null && grep -q 'richConstructs' src/channels/telegram.ts 2>/dev/null; then
  echo "✅ 18-telegram-rich-constructs applied"
else
  echo "❌ 18-telegram-rich-constructs MISSING"
  ALL_OK=false
fi

# Patch 20 — selectively eager-load core reply tools (send_message etc.)
if [ "$(grep -c "anthropic/alwaysLoad" container/agent-runner/src/mcp-tools/core.ts 2>/dev/null)" = "4" ]; then
  echo "✅ 20-eager-core-reply-tools applied"
else
  echo "❌ 20-eager-core-reply-tools MISSING (or partial — expected 4 occurrences of anthropic/alwaysLoad)"
  ALL_OK=false
fi

if $ALL_OK; then
  echo "🦫 All patches present."
  exit 0
else
  echo "⚠️  Some patches missing — see local-patches/README.md for re-apply workflow."
  exit 1
fi
