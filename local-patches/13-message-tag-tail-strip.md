# Patch 13 — Tolerant `<message>` parse: tail-strip, not first-match (edge-case fix for patch 12)

**File:** `container/agent-runner/src/message-blocks.ts` (agent-runner, mounted RO)
**Status:** 🟢 local-only (none upstream)
**Applied:** 2026-06-17

## Problem

Patch 12 made the `<message>` parser tolerant of a block accidentally closed
with `</parameter>`/`</invoke>` — but it did so with a lazy regex
(`[\s\S]*?<\/(?:message|parameter|invoke)>`) that terminates at the **first**
occurrence of any such tag, **even when it only appears quoted inside the body**.
So any message that mentions the tag name verbatim in its text was truncated at
that point.

Ground truth (Andy session, 2026-06-17 ~21:54): a confirmation message that
contained the tag name in backticks AND (accidentally) ended with the same tag
as its closer was cut at the **first** (in-body) occurrence — the user saw only
`…auf Patch-12-Code (tolerantes \`` instead of the whole message.

## Change

`parseMessageBlocks` rewritten from "first match" to **prefer-`</message>`,
else tail-strip**:

1. **PRIMARY** — if a real `</message>` exists in the block's region (bounded by
   the next `<message …>` opening), everything before it is the body, including
   any `</parameter>`/`</invoke>` quoted in the text. Never cut at a body tag
   when a real closer is present.
2. **FALLBACK** (no `</message>`) — take the whole region as the body and strip
   **only** a `</parameter>`/`</invoke>` sitting at the **true end** of the
   trimmed body (`/<\/(?:parameter|invoke)>$/`). A mid-body occurrence is kept.

No more mid-body cuts. Block regions are bounded by the next opening tag so a
no-closer block can't swallow the following block.

## Why it's safe

- A correct `</message>` block parses exactly as before (PRIMARY branch).
- The fallback only removes a single trailing stray tag — it can never remove
  text that isn't an accidental closer at the end.
- Pure module, fully unit-tested.

## Verify

`grep -q TRAILING_STRAY_CLOSE container/agent-runner/src/message-blocks.ts`
(see `verify.sh`). Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

Tests (`message-blocks.test.ts`, PATCH 13 block):
- (a) body quotes the tag in backticks AND ends with a stray `</parameter>` →
  full body kept, only the trailing tag stripped (the ground-truth regression).
- (b) body quotes the tag, closes with `</message>` → quoted tag stays.
- (c) normal `</message>` unchanged; plus trailing-whitespace + mid-body-only
  cases. `bun test` 141/141.

## Re-apply after upstream reset

`patch -p1 < local-patches/13-message-tag-tail-strip.diff` (refines patch 12's
`parseMessageBlocks` in the same file).
