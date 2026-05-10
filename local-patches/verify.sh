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
if $ALL_OK; then
  echo "🦫 All patches present."
  exit 0
else
  echo "⚠️  Some patches missing — see local-patches/README.md for re-apply workflow."
  exit 1
fi
