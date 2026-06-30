/**
 * PATCH 16 — Telegram Bot API 10.1 "Rich Messages" for native table rendering.
 *
 * The normal send path converts agent markdown to MarkdownV2, which has NO
 * table syntax — so a GFM pipe table degrades into an unreadable monospace
 * code block on Telegram. Bot API 10.1 added `sendRichMessage`, which renders
 * RAW markdown natively (GFM tables, task lists, etc.) as real, *selectable*
 * tables on supporting clients.
 *
 * We auto-route **table-primary** text messages to `sendRichMessage` and fall
 * back transparently to the normal path on ANY failure (unsupported endpoint,
 * parser error, oversize). Mirrors the Hermes telegram adapter
 * (`_content_is_pipe_table_primary` + `sendRichMessage`). Default-on for
 * tables only; disable entirely with `TELEGRAM_RICH_TABLES=false`.
 *
 * Scope note: like Hermes we only auto-route TABLES (the construct MarkdownV2
 * can't express). Task lists / <details> / block math would need a broader
 * opt-in and are intentionally NOT routed here.
 */
import type { RawMessage } from 'chat';

/** A GFM table divider line, e.g. `|---|:--:|`, `--- | ---`. Requires ≥2 columns. */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

/** Telegram Bot API 10.1 raw rich-message char cap. */
export const RICH_MESSAGE_MAX_CHARS = 32768;

/**
 * Strip fenced code blocks (``` … ```) and inline code spans (` … `) before
 * construct-detection. A message that merely *discusses* a rich construct inside
 * code — e.g. a sentence with `<details>` or a divider shown in backticks — must
 * NOT route to the rich path (which would make the whole message non-copyable).
 * Fixes the 2026-06-28 self-poisoning bug where a message explaining the rich
 * routing tripped its own detector. Order: fenced first, then inline.
 */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

/**
 * True when the message's primary rich construct is a GFM pipe table and it
 * carries none of the constructs that require the full rich opt-in (task
 * lists, <details>, block math). Conservative: needs a real divider line.
 */
export function isTablePrimary(markdown: string): boolean {
  const md = stripCode(markdown); // ignore tables shown inside code (2026-06-28)
  if (!md || md.indexOf('|') === -1) return false;
  // A real divider has the pipe/colon/dash structure AND at least one run of
  // ≥2 hyphens — this rejects ambiguous single-dash rows like `| - | - |`
  // (which appear in prose) the same way Hermes' is_table_divider does.
  const lines = md.split('\n');
  if (!lines.some((l) => TABLE_SEPARATOR_RE.test(l) && /-{2,}/.test(l))) return false;
  if (/(^|\n)\s*[-*]\s+\[[ xX]\]\s+/.test(md)) return false; // task list
  if (/(^|\n)\s*<\/?(details|summary)\b/i.test(md)) return false; // collapsible
  if (md.includes('$$')) return false; // block math
  return true;
}

/**
 * PATCH 18 — true when the message carries a construct MarkdownV2 simply CANNOT
 * render but Bot API 10.1 rich messages can: ATX headings, collapsible
 * `<details>`, horizontal dividers, block math, GFM task lists. Plain
 * bold/italic/links/bullets/blockquotes render fine under MarkdownV2 and are
 * intentionally NOT matched here — that keeps ordinary chat on the proven path
 * and only routes messages that genuinely gain from the rich renderer.
 */
export function hasRichOnlyConstruct(markdown: string): boolean {
  if (!markdown) return false;
  const md = stripCode(markdown); // a message *discussing* these in code must not route (2026-06-28)
  if (/(^|\n)#{1,6}[ \t]+\S/.test(md)) return true; // ATX heading
  if (/<details\b/i.test(md)) return true; // collapsible fold
  if (/(^|\n)[ \t]*([-*_])\2{2,}[ \t]*(\n|$)/.test(md)) return true; // hr divider --- *** ___
  if (md.includes('$$')) return true; // block math
  if (/(^|\n)[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/.test(md)) return true; // GFM task list
  return false;
}

/**
 * PATCH 18 — Telegram Desktop crashes on block math nested INSIDE a `<details>`
 * fold (Hermes #45995 / their `_has_telegram_desktop_details_math_crash_shape`).
 * Messages matching this shape must skip the rich path and degrade to MarkdownV2
 * rather than crash the client.
 */
export function hasTDesktopCrashShape(markdown: string): boolean {
  const block = stripCode(markdown).match(/<details\b[^>]*>[\s\S]*?<\/details>/i);
  return block ? block[0].includes('$$') : false;
}

/** Read the TELEGRAM_RICH_TABLES toggle (default ON). */
export function richTablesEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.TELEGRAM_RICH_TABLES ?? '').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * PATCH 18 — read the TELEGRAM_RICH_CONSTRUCTS toggle (default ON). Gates the
 * broad routing (headings/details/dividers/math/task-lists) independently from
 * tables, so it can be disabled alone if a rich-rendering quirk shows up.
 */
export function richConstructsEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.TELEGRAM_RICH_CONSTRUCTS ?? '').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * The endpoint itself is unavailable (old Bot API server without 10.1) — as
 * opposed to a per-message rejection. Callers latch rich OFF on these so they
 * don't pay a failed roundtrip on every send.
 */
export function isRichCapabilityError(e: unknown): boolean {
  const code = (e as { errorCode?: number })?.errorCode;
  const msg = String((e as { message?: string })?.message ?? e);
  if (code === 404) return true;
  // ONLY latch off on a genuine "this Bot API server has no rich-message method"
  // signal. NOT per-message 400s like "chat not found" / "message to edit not
  // found" — those must fall back for that one message WITHOUT killing rich
  // process-wide. CAUTION: our own error text contains "RichMessage", so we must
  // never key off a bare /rich/ match (that misclassified every per-message 400
  // → latched rich OFF after the first benign failure — the PATCH 17 launch bug).
  return /unknown method|method not found|method is not (available|supported)/i.test(msg);
}

export interface RichSendDeps {
  token: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a Telegram Bot API `chat_id` from the bridge thread id. The bridge
 * passes `tid` = `platformId` = `telegram:<chatId>` (see telegram.ts) — the
 * normal adapter strips the prefix internally; the rich endpoints need the same.
 * Handles a bare numeric id too (no prefix). Returns a number for numeric ids
 * (Telegram wants the integer form) or the raw string otherwise.
 */
export function chatIdFromTid(tid: string): number | string {
  const raw = tid.includes(':') ? tid.split(':').slice(1).join(':') : tid;
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Send `markdown` via Bot API 10.1 `sendRichMessage`. Returns a RawMessage in
 * the same shape the chat-sdk bridge expects from `adapter.postMessage`.
 * Throws on a non-`ok` Bot API response (caller decides fallback).
 */
export async function sendRichMessageRaw(
  deps: RichSendDeps,
  chatId: string,
  markdown: string,
  replyToMessageId?: number,
): Promise<RawMessage<unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const payload: Record<string, unknown> = {
    chat_id: chatIdFromTid(chatId),
    // RAW markdown — never the MarkdownV2-escaped form, which would destroy pipes.
    rich_message: { markdown },
  };
  if (replyToMessageId != null) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }
  const res = await doFetch(`https://api.telegram.org/bot${deps.token}/sendRichMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as {
    ok: boolean;
    result?: { message_id?: number };
    description?: string;
    error_code?: number;
  };
  if (!json.ok || !json.result || json.result.message_id == null) {
    const err = new Error(`sendRichMessage failed: ${json.error_code ?? res.status} ${json.description ?? ''}`.trim());
    (err as { errorCode?: number }).errorCode = json.error_code ?? res.status;
    throw err;
  }
  return { id: String(json.result.message_id), raw: json.result as unknown, threadId: chatId };
}

/**
 * PATCH 17 — edit an existing message via Bot API 10.1 `editMessageText` with a
 * `rich_message` payload, so a previously-plain bubble can be re-rendered with
 * native rich constructs (e.g. a collapsible `<details>` fold). Verified: a
 * MarkdownV2 message edits cleanly into a rich details block. Throws on a
 * non-`ok` response (caller decides fallback to the normal edit path).
 */
export async function editRichMessageRaw(
  deps: RichSendDeps,
  tid: string,
  messageId: string,
  markdown: string,
): Promise<RawMessage<unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const target = decodeRichEditTarget(messageId, tid);
  const payload = {
    chat_id: target.chatId,
    message_id: target.messageId,
    rich_message: { markdown },
  };
  const res = await doFetch(`https://api.telegram.org/bot${deps.token}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as {
    ok: boolean;
    result?: { message_id?: number } | boolean;
    description?: string;
    error_code?: number;
  };
  if (!json.ok) {
    const err = new Error(`editRichMessage failed: ${json.error_code ?? res.status} ${json.description ?? ''}`.trim());
    (err as { errorCode?: number }).errorCode = json.error_code ?? res.status;
    throw err;
  }
  const result = typeof json.result === 'object' && json.result ? json.result : undefined;
  const id = result?.message_id != null ? String(result.message_id) : messageId;
  return { id, raw: (result ?? json.result) as unknown, threadId: tid };
}

/**
 * Decode the chat-sdk telegram adapter's composite message id. The adapter
 * stores ids as `<chatId>:<messageId>` (see its `decodeCompositeMessageId`),
 * but the raw `editMessageText` endpoint needs the bare integer `message_id`
 * and numeric `chat_id`. A naive `Number(composite)` yields NaN → Telegram
 * "message to edit not found" (the second PATCH 17 launch bug). Falls back to
 * the thread id for chat when the id is already a bare integer.
 */
export function decodeRichEditTarget(messageId: string, tid: string): { chatId: number | string; messageId: number } {
  const i = messageId.lastIndexOf(':');
  if (i > 0 && i < messageId.length - 1) {
    const chatPart = messageId.slice(0, i);
    const msgPart = messageId.slice(i + 1);
    if (/^-?\d+$/.test(chatPart) && /^\d+$/.test(msgPart)) {
      return { chatId: Number(chatPart), messageId: Number(msgPart) };
    }
  }
  return { chatId: chatIdFromTid(tid), messageId: Number(messageId) };
}

/** True when the markdown carries a collapsible `<details>` fold — the only
 *  construct PATCH 17 routes through the rich EDIT path. Kept narrow so generic
 *  edits stay on the normal (MarkdownV2) path; broader routing is PATCH 18. */
export function hasDetailsFold(markdown: string): boolean {
  return /<details\b/i.test(stripCode(markdown));
}

/** Read the TELEGRAM_TOOLVIS_COLLAPSE toggle (default ON). When on, a finished
 *  turn collapses its tool-visibility bubble into a `<details>` fold. */
export function toolVisCollapseEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.TELEGRAM_TOOLVIS_COLLAPSE ?? '').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no';
}

/**
 * PATCH 17 — wrap accumulated tool-visibility lines in a collapsed `<details>`
 * fold. The summary stays visible (so the user knows work happened + can
 * inspect it); the per-call timeline hides behind a tap. Tool-vis lines never
 * contain block math, so the Telegram-Desktop details+math crash shape can't
 * arise here. Returns the original text unchanged when there are no lines.
 */
export function buildCollapsedToolVis(lines: string[]): string {
  const clean = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (clean.length === 0) return '';
  const n = clean.length;
  const summary = `🔧 ${n} Tool-Call${n === 1 ? '' : 's'} — aufklappen`;
  return `<details><summary>${summary}</summary>\n\n${clean.join('\n')}\n\n</details>`;
}
