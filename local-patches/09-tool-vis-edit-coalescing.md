# Patch 09 — Tool-visibility edit coalescing (debounced bubble edits + finalize flush)

**File:** `src/channels/chat-sdk-bridge.ts` (host orchestrator)
**Status:** 🟢 local-only (none upstream)
**Applied:** 2026-06-16

## Problem

The tool-visibility feature (patches 02–07) emits one `tv-*` preview message per
tool event. The host bridge accumulates them into a single rolling "bubble" and
**edited it in place on every preview** (`deliverToolVisAccumulator` →
`adapter.editMessage` per line). On a tool-heavy turn that means dozens of
`editMessageText` API calls:

> Measured in one 30-min window for one user: **211 tool-vis messages delivered
> vs 72 real assistant messages.** Each tv-edit is a separate Telegram API call.

Consequences:
- **Telegram flood-control / edit rate limits** get tripped by the volume.
- The real assistant reply (a fresh `sendMessage`) is **buried** among hundreds
  of tool-vis edits, and because edits don't notify, the user experiences "no
  answer / messages not arriving" even though nothing is technically dropped.

The user *likes* tool visibility — the goal is to **throttle/coalesce** it, not
remove it.

## Change

Coalesce the rolling-bubble edits in the accumulator:

- **New state** on `ToolVisAccumulator`: `lastEditAt`, `pendingTimer`, `dirty`.
- **`flushToolVis(tid, accumKey)`** — pushes the accumulator's current in-memory
  text to Telegram as a single `editMessage` (falling back to a fresh send if
  the edit fails). No-op if missing or not dirty.
- **`deliverToolVisAccumulator`** now: appends each preview to the bubble's
  in-memory `lines` and marks it `dirty`, then flushes **at most once per
  `TOOL_VIS_EDIT_THROTTLE_MS` (2500 ms)** — a leading-edge edit when the window
  has elapsed, otherwise a single trailing-flush `setTimeout` (wrapped in
  `enqueueOutbound` so it stays serialized per thread). Dozens of previews →
  a handful of API calls.
- **`finalizeToolVis(tid, accumKey)`** — replaces the bare
  `toolVisAccumulators.delete()` on the non-tool-vis path: cancels the pending
  timer and flushes the bubble's final state **synchronously**, so the bubble is
  complete *before* the real answer posts as its own fresh, **notifying**
  `sendMessage` below it (point 2 of the brief — the final answer is never an
  in-place edit and is never buried).
- **`teardown()`** clears any in-flight trailing-flush timers.

The length-guard rollover (new bubble at `maxTextLength`) is preserved and now
flushes the current bubble before starting a fresh one.

## Why it's safe

- Tool visibility is unchanged in *content* — the same lines accumulate into the
  same bubble; only the **cadence** of Telegram writes drops.
- All edits/sends for a thread remain serialized through `enqueueOutbound`
  (patch 08), including the trailing-flush timer.
- Timer callbacks guard on the accumulator still existing with its current
  `messageId`; a stale timer after finalize/rollover is a no-op.

## Verify

`grep -q TOOL_VIS_EDIT_THROTTLE_MS` + `function finalizeToolVis` +
`function flushToolVis` in `src/channels/chat-sdk-bridge.ts` (see `verify.sh`).

Unit tests: `src/channels/chat-sdk-bridge.test.ts` →
*"tool-vis edit coalescing (PATCH 09)"* — a 6-preview burst yields 1 fresh
bubble + 1 coalesced edit (not 6), and the answer posts fresh; an answer that
interrupts the throttle window forces a finalize-flush so the bubble shows its
last state.

Live: on a tool-heavy turn, `grep 'Message delivered' logs/nanoclaw.log | grep <uid>`
shows the tv-edit volume collapse from hundreds to a handful per turn, while the
real `msg-*` reply still lands as a distinct notifying message.

## Re-apply after upstream reset

`patch -p1 < local-patches/09-tool-vis-edit-coalescing.diff` (depends on
patch 04 + 08 being present — same `toolVisAccumulators` / `enqueueOutbound`
anchors).
