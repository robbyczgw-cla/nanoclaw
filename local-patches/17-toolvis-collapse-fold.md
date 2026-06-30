# Patch 17 — Collapse the tool-visibility timeline into a `<details>` fold

**Files:** `src/channels/telegram-rich-message.ts` (extended), `src/channels/telegram.ts` (edited), `src/channels/chat-sdk-bridge.ts` (edited), plus tests in `telegram-rich-message.test.ts` and `chat-sdk-bridge.test.ts`
**Status:** 🏠 local-only — rides on PATCH 09 (tool-vis edit-coalescing), which is itself a local feature, so this is **not** upstream-PR material (unlike PATCH 16/18, which are generic).
**Applied:** 2026-06-27

## Problem

PATCH 09 coalesces a tool-heavy turn's `_toolVis: true` previews into a single,
live-edited bubble — great while the turn runs, but when the answer lands the
bubble stays **fully expanded** above it: a wall of `🔧 …` lines the user has
already watched scroll by. On mobile (Telegram's primary surface) that wall
buries the actual reply.

## Idea (Robby's)

Show the tool calls live as they happen (PATCH 09, unchanged), then on turn-end
**collapse** them into a compact `🔧 N Tool-Calls — aufklappen` summary with the
full per-call timeline one tap away. Transparency on demand; clean chat by
default.

## How

Telegram **Bot API 10.1 Rich Messages** render a `<details>` block as a real
native collapsible fold (empirically verified, incl. editing a plain MarkdownV2
message into a fold via `editMessageText` + `rich_message`).

- **`telegram-rich-message.ts`** gains:
  - `editRichMessageRaw()` — `editMessageText` with a `rich_message` payload (the
    edit-path sibling of PATCH 16's `sendRichMessageRaw`).
  - `hasDetailsFold()` — narrow detector (`<details>` only) so generic edits stay
    on the normal path; broader rich routing is PATCH 18.
  - `buildCollapsedToolVis()` — wraps accumulated lines in
    `<details><summary>🔧 N Tool-Calls — aufklappen</summary> … </details>`
    (counted, singular/plural, blank-lines dropped). Tool-vis lines never carry
    block math, so the Telegram-Desktop `details`+math crash shape can't arise.
  - `toolVisCollapseEnabled()` — `TELEGRAM_TOOLVIS_COLLAPSE` toggle, default ON.
- **`telegram.ts`** `makeResilientTelegramSend` now also wraps `adapter.editMessage`:
  an edit whose markdown contains a `<details>` fold routes through
  `editRichMessageRaw`; **any** failure (incl. a Bot-API server without 10.1,
  which latches rich OFF) falls through to the normal edit — the bubble simply
  stays expanded, never lost. The factory passes
  `collapseToolVis: richTablesEnabled(env) && toolVisCollapseEnabled(env)` to the
  bridge (the rich path must be enabled for the fold to render).
- **`chat-sdk-bridge.ts`** `finalizeToolVis` — when `config.collapseToolVis` and
  the accumulator has lines, it performs ONE final `editMessage` with the folded
  markdown instead of the expanded flush, then deletes the accumulator. On any
  edit error it falls back to the plain `flushToolVis` (PATCH 09 behaviour).

## Safety / fallbacks

- **Flag-gated** (`TELEGRAM_TOOLVIS_COLLAPSE=false` disables) and additionally
  gated on `TELEGRAM_RICH_TABLES` being on.
- **Graceful degradation**: rich edit fails → normal edit → expanded bubble.
  Worst case is exactly the pre-patch (PATCH 09) behaviour. No message is lost.
- **One extra API call per turn** (the final collapse edit). No new per-tool-call
  cost; PATCH 09's throttling is untouched.

## Known limitation

A turn so tool-heavy that the bubble exceeds `maxTextLength` (4000) starts a
fresh bubble (PATCH 09 length-guard). Only the **last** bubble collapses; earlier
ones remain expanded. Rare; acceptable.

## Verification

- `vitest` — 47/47 in the two touched files (new: `editRichMessageRaw`,
  `hasDetailsFold`, `toolVisCollapseEnabled`, `buildCollapsedToolVis`, and two
  bridge integration tests: collapse-on-answer + default-off-preserves-PATCH-09).
- `tsc --noEmit` — exit 0, project-wide.
- Live API: plain message → `editMessageText`/`rich_message` `<details>` →
  `ok:true`, blocks `[details]`.

## Launch bugs found live + fixed (2026-06-27, same night)

The first deploy rendered the fold as **literal `<details>` text** (rich edit
fell to the MarkdownV2 path). Root cause was three layered bugs in the raw-fetch
helpers (which bypass the adapter's own id normalization):

1. **chat_id prefix** — bridge passes `tid = "telegram:<chatId>"`; raw API needs
   the bare numeric id. → `400 chat not found`. Fix: `chatIdFromTid()` strips the
   prefix (mirrors the adapter).
2. **composite message_id** — the adapter stores ids as `"<chatId>:<messageId>"`;
   `Number(composite)` = NaN → `400 message to edit not found`. Fix:
   `decodeRichEditTarget()` splits on the last `:`.
3. **latch self-poison (the killer)** — `isRichCapabilityError` matched "rich" in
   our OWN error text ("editRichMessage failed: …"), so every per-message 400 was
   misread as "server lacks rich" → rich latched OFF **process-wide** → permanent
   literal until restart. Fix: match only `/unknown method|method not found|method
   is not (available|supported)/`, never a bare `/rich/`.

Diagnosed from `/root/nanoclaw-v2/logs/nanoclaw.error.log` (the orchestrator logs
to files, not journald). Verified end-to-end against the live bot with the exact
adapter id formats. 54/54 tests, tsc 0.
