# Patch 21 — fallback delivery for unwrapped replies (root-cause: model omits the wrapper)

**Files:** `container/agent-runner/src/poll-loop.ts`, `message-blocks.ts`,
`providers/claude.ts`, `providers/types.ts`
**Status:** 🟢 local-only
**Applied:** 2026-07-02

## Root cause (measured, not guessed)

Recurring drops: the main agent's `<message to="…">…</message>` reply block
sometimes never reached the user (silence + "not delivered" reminder), while
the `send_message` MCP path delivered 100%.

Verified against the RAW Claude API transcript
(`~/.claude/projects/…/<session>.jsonl` inside the running dm-with-robby
container, 2026-07-02, 9 failing turns): **in 8 of 9 failing turns the entire
turn contains ZERO `<message` opening tags** (the 9th had exactly one
attribute-less/unclosed tag). The model — after long tool chains — simply
never types the wrapper. The PATCH 11 accumulation pipeline
(`extractMainAgentText`/`appendTurnText`) loses nothing; the tolerant parser
(PATCH 12/13) is correct. **No code was dropping the wrapper — the wrapper
was never emitted.** A re-prompt nudge (PATCH 12) sometimes rescued the turn,
but often burned 1–2 extra API turns and still failed (model answered the
nudge with `<internal>`-only or bare text again).

## Fix — deliver instead of nudge

This is the same theme as patches 11/12/13 (message-delivery robustness); 21
consolidates the endgame: **when a turn ends with zero deliverable blocks,
deliver the model's final text chunk directly** instead of re-prompting.

1. **`providers/types.ts` + `providers/claude.ts`** — the `result` event now
   also carries `lastText`: the LAST non-empty main-agent text chunk of the
   turn (vs `text`, which accumulates all chunks). In every observed failure
   the last chunk was the complete intended reply; the earlier chunks were
   tool-chain narration.
2. **`message-blocks.ts`** — `salvageUnwrappedReply()`: strips `<message …>`
   open-tag remnants (covers unclosed/attribute-less variants), `</message>`
   closers, and — mirroring PATCH 13 — a stray `</parameter>`/`</invoke>` at
   the true end only. Returns `null` if nothing user-facing remains.
3. **`poll-loop.ts`** — reworked `hasUnwrapped` handling:
   - **No blocks at all** → salvage `stripInternalTags(lastText ?? text)` and
     deliver to the triggering channel (`deliverToTriggeringChannel`, shared
     with the error-result path). No re-prompt. Log: `[fallback-delivery]`.
   - **Final chunk `<internal>`-only/empty** → the model explicitly ended on a
     no-reply note (e.g. "already sent via send_message tool") → treat as
     complete, no nudge (pre-21 the nudge produced apology-noise turns).
   - **A2A guard:** fallback delivery is skipped entirely when the triggering
     channel is `agent` (agent-to-agent or a self-addressed wake message) — an
     auto-delivered bare reply there can bounce back as a new inbound to the
     same group and self-loop (observed once during live verification; the
     chain terminated only because the follow-up ended `<internal>`-only).
   - **Unknown destination in a parsed block** → KEEP the PATCH 12 re-prompt
     (specific feedback, capped at 2) — the model must fix its own routing.
     If the cap exhausts, the salvage fallback delivers the block body.
   - Exchange status: `undelivered` only when nothing could be salvaged.

## Behavior changes to be aware of

- Bare-text turns are now DELIVERED, not silently dropped: e.g. a mid-turn
  "Context compacted." system result reaches the chat once in a while.
  Accepted tradeoff — delivery beats silence, and every observed bare text
  was a real reply.
- The re-prompt loop (`MAX_UNWRAPPED_RETRIES`) now fires ONLY for
  unknown-destination blocks — far fewer nudge turns.

## Verify

`grep -q "salvageUnwrappedReply" container/agent-runner/src/poll-loop.ts`
plus tests: `cd container/agent-runner && bun test` (see
`poll-loop.test.ts` "unwrapped-reply fallback delivery (PATCH 21)" and
`message-blocks.test.ts` "salvageUnwrappedReply"). Live: takes effect on next
container respawn (src is volume-mounted; no image rebuild).

## Re-apply after upstream reset

Re-apply the four-file diff (`21-unwrapped-reply-fallback.diff`); the tests
in `poll-loop.test.ts` / `integration.test.ts` / `message-blocks.test.ts`
encode the expected behavior (two pre-21 tests assert the OLD nudge behavior
and were updated deliberately).
