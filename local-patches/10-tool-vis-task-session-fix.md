# Patch 10 — Tool-vis task-session misclassification fix

**File:** `container/agent-runner/src/hooks/tool-visibility.ts` (agent-runner, mounted RO)
**Status:** 🟢 local-only (none upstream)
**Applied:** 2026-06-16

## Problem

`isTaskSession()` (patch 06) decides whether to suppress tool-visibility for a
turn. Scheduled-task wakes run silent-on-OK, so leaking tool previews from a cron
into chat is orphan noise — hence the suppression. But the check was:

```js
SELECT kind FROM messages_in ORDER BY seq DESC LIMIT 1
return row?.kind === 'task'
```

It looked at the **global-latest inbound row**, not the message that triggered
*this* turn. The ~10-minute infra-monitoring cron inserts a `task` row into
inbound whenever it fires. If that happened to land **during an interactive chat
turn**, every subsequent tool call in that turn saw "latest inbound = task" →
`isTaskSession()` returned `true` → `emit()` bailed → **the whole chat reply lost
its tool-visibility.** Intermittent and timing-dependent — it looked random
("tool-vis sometimes doesn't show"). Confirmed live: a chat turn 05:59→06:01 went
fully tool-vis-silent because the monitoring cron (seq 21976) landed at 06:00:54,
mid-turn.

## Change

Classify on **this turn's batch**, not the global-latest row. The poll-loop's
`markProcessing()` records the current turn's messages in `outbound.db`'s
`processing_ack` with `status='processing'`. A cron task inserted mid-turn is
still `pending` (it's picked up on a *future* poll) and is therefore NOT in this
batch. We:

1. Read `processing_ack` rows with `status='processing'` (the in-flight batch).
2. Resolve their `kind` from `messages_in`.
3. Suppress **only** when the batch is non-empty and contains **no** chat-kind
   message — i.e. a genuine task-only wake. Any interactive chat message in the
   batch keeps tool-vis on, even if a cron task also rode along.

Fail-safe: empty/unresolvable batch → `false` (show tool-vis) rather than risk
silencing an interactive turn.

## Why it's safe

- A real scheduled-task-only wake still suppresses (batch = task-only → `true`).
- Cross-DB read only (no writes); wrapped in try/catch → on any error, defaults
  to showing tool-vis (the user-visible-safe direction).
- Container source is mounted RO (`container-runner.ts`), so this lands on every
  agent's next container spawn — no image rebuild, no orchestrator restart.

## Verify

`grep -q "processing_ack WHERE status = 'processing'"` +
`grep -q "PATCH 10"` in `container/agent-runner/src/hooks/tool-visibility.ts`
(see `verify.sh`). Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

Live: trigger a tool-heavy chat turn while the monitoring cron is near — tool-vis
now renders throughout (and patch 09 coalesces its edits).

## Re-apply after upstream reset

`patch -p1 < local-patches/10-tool-vis-task-session-fix.diff` (depends on
patch 06 having introduced `isTaskSession`).
