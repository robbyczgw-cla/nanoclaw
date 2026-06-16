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
if grep -q 'resolveTurnDispatchText' container/agent-runner/src/providers/claude.ts 2>/dev/null \
   && grep -q 'extractMainAgentText' container/agent-runner/src/providers/turn-text.ts 2>/dev/null \
   && grep -q 'countMessageOpenTags' container/agent-runner/src/poll-loop.ts 2>/dev/null; then
  echo "✅ 11-message-block-enqueue-fix applied"
else
  echo "❌ 11-message-block-enqueue-fix MISSING (or partial — check claude.ts + turn-text.ts + poll-loop.ts)"
  ALL_OK=false
fi

if $ALL_OK; then
  echo "🦫 All patches present."
  exit 0
else
  echo "⚠️  Some patches missing — see local-patches/README.md for re-apply workflow."
  exit 1
fi
