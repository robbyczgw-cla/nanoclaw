# Patch 22 — Telegram MarkdownV2 entity hardening (Underline/URL rejects)

**File:** `src/channels/telegram-markdown-v2.ts` (+ tests)
**Status:** 🟢 local-only, both root causes are upstream-PR candidates (vercel/chat)
**Applied:** 2026-07-04

## Symptom

Telegram sends from agents on `claude-fable-5` / `claude-sonnet-5` failed with
`Bad Request: can't parse entities: Can't find end of Underline entity` or
`… Can't find end of a URL`; messages only arrived via the plain-text
fallback. `claude-opus-4-8` never triggered it (style, not capability).

## Root causes (both inside `@chat-adapter/telegram`, verified in dist source)

1. **URL family:** `trimToMarkdownV2SafeBoundary` runs before EVERY MarkdownV2
   send and slices the text at the last "unpaired" entity marker. It counts
   `_` / `*` / `~` / `` ` `` **inside link URLs**, where Telegram's spec
   deliberately leaves them unescaped (`escapeLinkUrl` escapes only `)` and
   `\`). An odd number of `_` across a message's URLs ⇒ the converted text is
   cut MID-URL ⇒ Telegram rejects the unterminated URL entity. Both logged
   failures end exactly before a `_` in a GitHub URL (`generative_agents`,
   `_submissions`).
2. **Underline family:** fable/sonnet emit nested/unbalanced emphasis like
   `__weitgehend gelöst_ … _`. mdast parses this as emphasis-inside-emphasis
   and the renderer emits ADJACENT underscores (`__x_ y_`). Telegram tokenizes
   `__` as ONE underline-open with no close ⇒ reject. The adapter's parity
   check counts single chars (4 = "balanced") so it doesn't catch it.

## Fix — input-side hardening in our `transformOutboundText` hook

`hardenForTelegramV2()` in `telegram-markdown-v2.ts`, applied inside
`telegramV1ToCommonMark` (code spans excluded via the existing placeholder
window, before single-star bold promotion):

1. Percent-encode the four entity-marker chars inside link destinations
   (`](…)`) and bare `http(s)://` URLs: `_`→`%5F`, `*`→`%2A`, `~`→`%7E`,
   `` ` ``→`%60`. Semantically identical URLs; the trimmer then finds no
   markers inside URLs and can never cut mid-URL.
2. Rewrite balanced `__x__` → `**x**` (renders bold; converter output
   contains no `__`).
3. Escape leftover (unbalanced) `__` runs to literals (`\_\_`), so the parser
   can never produce adjacent-underscore emphasis nesting.

Plain-text fallback (`makeResilientTelegramSend`, patch 05) is untouched and
remains the safety net for anything unforeseen.

## Verify

`pnpm exec vitest run src/channels/telegram-markdown-v2.test.ts` — the PATCH
22 block runs both real failure payload shapes through the REAL
`TelegramFormatConverter` and asserts no unclosed entity (mini Telegram
entity scanner in the test). Red without `hardenForTelegramV2`, green with it.
Static check: `grep -q hardenForTelegramV2 src/channels/telegram-markdown-v2.ts`.

## Upstream note (vercel/chat)

Two separate upstream fixes would obsolete this patch:
- `trimToMarkdownV2SafeBoundary` must skip link-destination spans (`](…)`)
  when counting entity markers, and treat `__` as one underline token.
- `renderMarkdownV2` must not emit adjacent `_` from nested emphasis
  (flatten emphasis-in-emphasis in `fromAst`).
Worth filing against vercel/chat alongside the existing mode-aware-converter
thread (see `telegram-markdown-sanitize.ts` header, PR #367).

## Re-apply after upstream reset

Re-add `hardenForTelegramV2` + its call in `telegramV1ToCommonMark`
(`22-telegram-v2-entity-hardening.diff`); the test block in
`telegram-markdown-v2.test.ts` encodes the expected behavior.
