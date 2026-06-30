# Patch 18 — Broaden rich routing to MarkdownV2-impossible constructs

**Files:** `src/channels/telegram-rich-message.ts` (extended), `src/channels/telegram.ts` (routing broadened), tests in `telegram-rich-message.test.ts`
**Status:** 🟢 local-only — generic (no dependency on a local feature), so a candidate for an upstream PR to `nanocoai/nanoclaw` alongside PATCH 16.
**Applied:** 2026-06-27
**Builds on:** PATCH 16 (rich tables / send path) — reuses `sendRichMessageRaw` and the same latch/fallback machinery (incl. the PATCH-17-era chat_id + capability-error fixes).

## Problem

PATCH 16 only auto-routes **table-primary** messages to Bot API 10.1
`sendRichMessage`. But MarkdownV2 also can't render several other constructs an
agent naturally wants: **ATX headings** (`## …`), **collapsible `<details>`**,
**horizontal dividers** (`---`), **block math** (`$$…$$`), and **GFM task lists**
(`- [ ]`). Those degrade (headings vanish, dividers become literal dashes, etc.).

## How

- **`hasRichOnlyConstruct(md)`** — true iff the message carries a
  MarkdownV2-impossible construct (heading / `<details>` / divider / block math /
  task list). Plain **bold, italic, links, bullet lists, blockquotes** are
  intentionally NOT matched — MarkdownV2 renders them fine, so ordinary chat
  stays on the proven path and only messages that genuinely benefit go rich.
- **`hasTDesktopCrashShape(md)`** — true for block math nested INSIDE a
  `<details>` fold, which crashes Telegram Desktop (Hermes #45995). Such messages
  skip the rich path and degrade to MarkdownV2 rather than crash the client.
- **`telegram.ts`** routing predicate broadened:
  `isTablePrimary(md) || (richConstructs && hasRichOnlyConstruct(md) && !hasTDesktopCrashShape(md))`.
  Everything else (latch-off on a genuine capability error, transparent fallback
  to MarkdownV2 on any failure, the chat_id/message_id handling) is unchanged.
- **`richConstructsEnabled(env)`** — `TELEGRAM_RICH_CONSTRUCTS` toggle (default
  ON), AND gated on `TELEGRAM_RICH_TABLES`. So the broad routing can be disabled
  on its own (`TELEGRAM_RICH_CONSTRUCTS=false`) if a rich-render quirk appears,
  without losing tables.

## Safety / fallbacks

- Default-on but independently toggleable; inherits PATCH 16's transparent
  MarkdownV2 fallback — any rich failure still delivers the message.
- The TDesktop details+math crash shape is explicitly excluded.
- Surgical scope: a normal Cami-style message (`*bold*` pseudo-headers + bullets)
  does NOT match `hasRichOnlyConstruct`, so it stays on MarkdownV2 — only real
  headings/dividers/details/math/task-lists route.

## Verification

- `vitest` — 60/60 across the two touched files (new: `hasRichOnlyConstruct`,
  `hasTDesktopCrashShape`, `richConstructsEnabled`, with positive + negative
  cases incl. the crash-shape exclusion and plain-content non-matching).
- `tsc --noEmit` — exit 0, project-wide.
- Native rendering of headings / dividers / blockquotes / details / math / task
  lists / inline images was verified live against the bot earlier (Bot API 10.1).

## Fix 2026-06-28 — code-span/block false-positive (copyability)

Rich-routed messages aren't whole-message copyable on Telegram clients (native
blocks, not plaintext — the reason Hermes keeps rich opt-in off). That's an
accepted trade-off for tables/folds, BUT the detectors matched constructs even
inside backticks/code-blocks, so a message merely *discussing* a fold-tag /
heading / divider in code falsely routed → non-copyable (a message explaining
the bug poisoned itself). Fix: new `stripCode()` removes fenced blocks + inline
spans before detection; applied in `isTablePrimary`, `hasRichOnlyConstruct`,
`hasDetailsFold`, `hasTDesktopCrashShape`. 64/64 tests, tsc 0. (Routing breadth
itself left as-is per Robby — only the code-span bug fixed.)
