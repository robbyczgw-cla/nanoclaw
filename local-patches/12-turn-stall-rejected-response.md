# Patch 12 — Turn-stall on a rejected response (tolerant parse + capped re-prompt)

**Files:** `container/agent-runner/src/poll-loop.ts`,
`container/agent-runner/src/message-blocks.ts` (new) (agent-runner, mounted RO)
**Status:** 🟢 local-only (none upstream)
**Applied:** 2026-06-17

## Problem

When the model emitted an invalid final response — a `<message to="…">…</message>`
block accidentally closed with `</parameter>` or `</invoke>` (tool-call syntax
bleed), or a block addressed to an unknown destination name — the harness
discarded the whole response and pushed the generic *"not delivered — wrap in
<message>… re-send"* reminder. Two failure modes followed:

1. The reminder was **misleading**: the response *was* wrapped — it was just a
   tag typo or a wrong destination name. The model couldn't tell what to fix, so
   it repeated the same mistake.
2. The retry cap was a single boolean (`unwrappedNudged`): after **one** failed
   retry the turn gave up and went **idle**, resuming only when the next inbound
   event arrived (a cron task or a new user message).

Ground truth (Andy `ag-1777025681762-hxll8e`, 2026-06-17): real work
19:05:08–19:06:33, then nothing until the infra-monitor cron at 19:30 → **24-min
stall**. A live example was also caught in the Cami-family container log
(`<message to="telegram">` → unknown destination → discarded → one repeat →
idle → host killed it at the 30-min heartbeat ceiling).

## Change

New pure module **`message-blocks.ts`** (unit-testable, no SDK/DB):

- `parseMessageBlocks(text)` — **tolerant** closing tag: accepts `</message>`,
  `</parameter>` and `</invoke>` as the block terminator, with positions so the
  caller can rebuild scratchpad gaps. A single tag typo no longer discards a
  valid message → the reported stall trigger is **eliminated** (the message is
  delivered, never rejected).
- `countMessageBlockOpenTags` — for the malformed-block guard (patch 11).
- `buildRewrapReminder(unknownDestinations, destinationNames)` — **specific**
  feedback: names the invalid destination(s) (or the missing/typo'd-tag case)
  and lists the valid destination names, so the model can self-correct.

`poll-loop.ts`:

- `dispatchResultText` uses `parseMessageBlocks`, returns `unknownDestinations`.
- The result handler re-prompts **in-turn** with the specific reminder and a
  **counter cap** (`MAX_UNWRAPPED_RETRIES = 2`, was a single bool). On cap
  exhaustion it **gives up loudly** (logs) instead of silently idling.
- Loud logs on every discard / re-prompt / give-up — silent vanishing is gone.

## Why it's safe (all agents)

- Tolerant parsing only *widens* what counts as a closing tag; a correct
  `</message>` block parses exactly as before.
- The cap is small (2) and the reminder is additive — no infinite loop (after 2
  re-prompts it gives up). Reset to 0 whenever a real new follow-up arrives.
- Pure module → fully unit-tested. Container source is mounted RO → lands on each
  agent's next container spawn.

## Verify

`grep -q parseMessageBlocks container/agent-runner/src/message-blocks.ts` +
`grep -q MAX_UNWRAPPED_RETRIES container/agent-runner/src/poll-loop.ts`
(see `verify.sh`). Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

Tests: `container/agent-runner/src/message-blocks.test.ts` — the regression
(`</parameter>`-closed block parses, not discarded), `</invoke>`, mixed/multiple
blocks, the guard, and the specific-reminder builder. `bun test` 136/136.

Live: a reply whose closing tag is typo'd is delivered immediately (no
discard/stall); an unknown-destination reply is re-prompted in-turn with the
valid names and recovers within the turn instead of idling.

## Re-apply after upstream reset

`patch -p1 < local-patches/12-turn-stall-rejected-response.diff` (the new
`message-blocks.ts` is included; touches the same `dispatchResultText` /
result-handler region as patch 11).
