# Patch 11 — `<message>` block enqueue fix (lost replies after long tool chains)

**Files:** `container/agent-runner/src/providers/claude.ts`,
`container/agent-runner/src/poll-loop.ts`,
`container/agent-runner/src/providers/turn-text.ts` (new) (agent-runner, mounted RO)
**Status:** 🟢 local-only (none upstream)
**Applied:** 2026-06-16

## Problem

A final assistant reply wrapped in `<message to="NAME">…</message>` blocks
**intermittently never got written to `messages_out`** — not dropped on send,
never enqueued. Silent: no error, the block just vanished. The `send_message`
MCP path always landed; only final-turn wrapped `<message>` blocks failed.
Observed live (Andy, 2026-06-16): last enqueued reply seq 27293 (~17:01), then
two well-formed `<message>` blocks never appeared — Andy himself noticed
("meine letzten zwei Nachrichten sind nicht durchgekommen").

## Root cause

The runner parses `<message>` blocks in `dispatchResultText(event.text, …)`,
where `event.text` is fed **only** from the SDK's `result.result` field. But the
provider's `translateEvents` (claude.ts) ignored streaming `assistant` messages
entirely and surfaced just the `result` — and `result.result` is **only the
FINAL assistant text of the turn**.

On a long tool-use chain the model frequently emits its `<message>` reply and
THEN makes one more tool call (a final verification, a follow-up read). The SDK
runs that tool and the turn ends with a short post-tool text, so `result.result`
is that short text and the earlier `<message>` block was **never scanned**. The
longer the tool chain, the more often a `<message>` is followed by a trailing
tool_use → the more replies vanish. `send_message` was immune because it writes
to `messages_out` immediately via its MCP handler.

## Change

1. **`turn-text.ts`** (new, pure/testable helpers):
   - `extractMainAgentText(msg)` — text of a MAIN-agent assistant message
     (excludes sub-agent/Task messages via `parent_tool_use_id`, and tool-only
     content).
   - `appendTurnText` / `resolveTurnDispatchText(turnText, resultText)` — prefer
     the full accumulated turn text, fall back to `result.result`.
   - `countMessageOpenTags(text)` — for the loud-fail guard.
2. **`claude.ts` `translateEvents`** now accumulates every main-agent assistant
   text block into `turnText` and, at the `result` event, dispatches
   `resolveTurnDispatchText(turnText, result.result)` (a superset of
   `result.result`). Reset per turn. Catches `<message>` blocks emitted before a
   trailing tool_use.
3. **`poll-loop.ts` `dispatchResultText`** — exported for testing + a **loud-fail
   guard**: if the text has more `<message …>` opening tags than complete blocks
   parsed, log a WARNING (malformed/unclosed block that was NOT enqueued).
   Silent vanishing is now visible.

## Why it's safe (all agents)

- For a normal turn (reply is the last text, no trailing tool), `turnText` equals
  `result.result` → **identical behavior**.
- Strictly additive: it can only enqueue MORE `<message>` blocks (the ones that
  were being lost), never fewer.
- Sub-agent text excluded (`parent_tool_use_id`) → no double-send.
- `turnText` resets at every `result` → no cross-turn bleed on follow-up pushes.
- Container source is mounted RO → lands on every agent's next spawn; no image
  rebuild, no orchestrator restart (the orchestrator does not run this code).

## Verify

`grep -q resolveTurnDispatchText container/agent-runner/src/providers/claude.ts`
+ `grep -q countMessageOpenTags container/agent-runner/src/poll-loop.ts`
(see `verify.sh`). Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

Tests: `container/agent-runner/src/providers/turn-text.test.ts` — the regression
("a `<message>` block before a trailing tool_use is kept"), multi-block,
sub-agent exclusion, fallback, and the guard's tag counting. `bun test` 126/126.

Live: a tool-heavy chat turn whose reply is wrapped in `<message>` lands in
`messages_out` reliably.

## Re-apply after upstream reset

`patch -p1 < local-patches/11-message-block-enqueue-fix.diff` (the new
`turn-text.ts` is included in the diff).
