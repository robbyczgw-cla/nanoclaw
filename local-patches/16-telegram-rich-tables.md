# Patch 16 — Native Telegram tables via Bot API 10.1 Rich Messages

**Files:** `src/channels/telegram-rich-message.ts` (new), `src/channels/telegram-rich-message.test.ts` (new), `src/channels/telegram.ts` (edited)
**Status:** 🟢 local-only (candidate for upstream PR to `nanocoai/nanoclaw`)
**Applied:** 2026-06-27

## Problem

Telegram MarkdownV2 (the normal send path) has **no table syntax**. A GFM pipe
table sent through `sendMessage` degrades into an unreadable monospace code
block on the client. Hermes (the sibling agent) shows clean, *selectable*,
natively-bordered tables in Telegram — Robby asked us to learn how.

## Root cause / how Hermes does it (researched in Hermes source)

Telegram **Bot API 10.1** added **`sendRichMessage`**, which renders RAW markdown
natively — including GFM tables, task lists, `<details>`, block math — as real
selectable content (not an image). Hermes' `plugins/platforms/telegram/adapter.py`:

- `_content_is_pipe_table_primary()` → any **table-primary** message auto-routes
  to `sendRichMessage` **even when the global `rich_messages` opt-in is off**
  ("MarkdownV2 has no table syntax").
- Payload: `{chat_id, rich_message: {markdown: <raw>}}` (+ `reply_parameters`),
  via `do_api_request("sendRichMessage", ...)`.
- Transparent fallback to MarkdownV2 on any rejection; capability errors (old
  Bot API server without 10.1) latch rich off for the process lifetime.

NanoClaw only ever used the old `sendMessage` + MarkdownV2 path
(`telegram-markdown-v2.ts` is a bold-only transform, no table logic).

## Change

New module `telegram-rich-message.ts`:
- `isTablePrimary(md)` — true when the message's primary rich construct is a GFM
  pipe table (real `--`+ divider line) and it carries no task-list / `<details>`
  / block-math construct (those need a broader opt-in). Mirrors
  `is_table_divider` (single-dash rows like `| - | - |` are NOT dividers).
- `sendRichMessageRaw(deps, chatId, markdown, replyTo?)` — raw `fetch` to
  `…/sendRichMessage` with `{chat_id, rich_message:{markdown}}`; returns the same
  `RawMessage` shape `adapter.postMessage` returns; throws (tagged `errorCode`)
  on a non-`ok` Bot API response.
- `isRichCapabilityError`, `richTablesEnabled` (env toggle).

`telegram.ts` — `makeResilientTelegramSend(adapter, token, richEnabled)`:
before the normal send, table-primary **text** messages (no media, ≤32 768 chars)
are routed to `sendRichMessageRaw`. **Any** failure falls through to the existing
MarkdownV2 path (message never lost); a capability error latches rich off via a
closure flag. NanoClaw already does raw `api.telegram.org` fetches, so no new dep.

## Config

Default **ON for tables only** (the construct MarkdownV2 can't express). Disable
with `TELEGRAM_RICH_TABLES=false` in the channel env file. Non-table messages
(plain prose, bold, lists) are untouched — stay on MarkdownV2 for consistent
font weight + easy plain-text copy.

## Why it's safe

- Pure additive routing with a total fallback: if `sendRichMessage` is missing or
  rejects, the message takes the exact pre-patch path.
- No new dependency; no change to the inbound/pairing path.
- `npm run build` clean, `tsc --noEmit` clean; 14 new unit tests + 25 existing
  telegram tests green.

## Caveat (carry into the upstream PR)

Bot API rich messages can be harder to **copy as plain text** on some current
clients — which is why Hermes keeps the *full* rich path opt-in. We scope-limit
to tables (high value, MarkdownV2 can't do them) and keep an env kill-switch.
Upstream PR should default the broad behaviour off and document the tradeoff.

## Verify

`grep -q sendRichMessageRaw src/channels/telegram.ts` (see `verify.sh` check 16).
Live check: send a pipe table to a Telegram chat → renders as a native table.
