/**
 * Outbound transform for the MarkdownV2-native @chat-adapter/telegram (>=4.30).
 *
 * The 4.30 adapter parses the message body as **standard CommonMark** and
 * renders it to Telegram MarkdownV2 (`TelegramFormatConverter`: `fromAst(toAst(text))`),
 * escaping every special char on the way out. That converter handles — natively
 * and correctly — every fragility the old legacy-"Markdown" V1 path needed
 * `sanitizeTelegramLegacyMarkdown` to paper over:
 *   - underscores in bare paths/identifiers  → escaped literal (not italic)
 *   - `*` / `_` inside backtick code spans    → preserved verbatim
 *   - nested bold+code, unbalanced delimiters → no whole-message plaintext fallback
 *   - brackets, parens, dots, headers, links  → escaped / rendered correctly
 *
 * So this transform does exactly ONE thing the converter can't infer: our agents
 * were trained (CLAUDE.md) on Telegram V1 where a SINGLE `*x*` means bold. Under
 * CommonMark a single `*x*` is *emphasis* (italic), so without this it would
 * silently flip every agent's bold to italic. We rewrite single-`*bold*` to
 * CommonMark `**bold**` (strong) so it renders as bold under V2 — while leaving
 * existing `**bold**`, `_italic_`, code spans, bullets, and literal/arithmetic
 * `*` untouched. Everything else is delegated to the adapter's V2 converter.
 *
 * Transitional: once agents are migrated to native CommonMark (`**bold**`) this
 * can be removed. Kept as a forgiving compat layer in the meantime. The patch-05
 * `makeResilientTelegramSend` wrapper remains a separate plain-text safety net.
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

/**
 * Match a single-`*`-delimited span and promote it to `**…**`:
 *   - `(?<!\*)` open star not preceded by `*`  → don't touch the first `*` of `**`
 *   - `(?!\*)`  open star not followed by `*`  → ditto
 *   - `[^\s*]`  first content char is non-space → skip `* ` bullets and `2 * 3` arithmetic
 *   - `[^*\n]*?` lazy, code-class excludes `*`  → linear, no catastrophic backtracking
 *   - close `*` likewise not part of a `**`
 */
const SINGLE_STAR_BOLD = /(?<!\*)\*(?!\*)([^\s*][^*\n]*?)\*(?!\*)/g;

/**
 * PATCH 22 — harden model output against two @chat-adapter/telegram converter
 * bugs that reject the whole send with "can't parse entities" (fable/sonnet
 * emit the triggering shapes; opus' style happens not to):
 *
 * 1. "Can't find end of a URL": the adapter's `trimToMarkdownV2SafeBoundary`
 *    runs before EVERY MarkdownV2 send and slices the text at the last
 *    "unpaired" entity marker — but it counts `_` / `*` / `~` / backticks
 *    INSIDE link URLs, where Telegram's spec deliberately leaves them
 *    unescaped (`escapeLinkUrl` only escapes `)` and `\`). An odd number of
 *    `_` across the message's URLs ⇒ the send is cut MID-URL ⇒ Telegram
 *    rejects the unterminated URL entity. Fix: percent-encode the four
 *    entity-marker chars inside link destinations and bare URLs before the
 *    converter ever sees them (`_`→%5F etc. — semantically identical URLs).
 *
 * 2. "Can't find end of Underline entity": nested/unbalanced emphasis like
 *    `__weitgehend gelöst_ … _` parses as emphasis-inside-emphasis, which the
 *    renderer emits as ADJACENT underscores (`__x_ y_`). Telegram tokenizes
 *    `__` as one underline-open with no close ⇒ reject. (The adapter's parity
 *    check counts single chars — 4 underscores = "balanced" — so it doesn't
 *    catch it.) Fix: rewrite balanced `__x__` to `**x**` (bold, no
 *    underscores in output) and escape any leftover `__` run to literals so
 *    the parser can never produce adjacent-underscore emphasis nesting.
 */
const LINK_DEST = /\]\(([^)\s]+)\)/g;
const BARE_URL = /(?<!\]\()https?:\/\/[^\s<>)]+/g;
const URL_ENTITY_MARKERS = /[_*~`]/g;
const URL_MARKER_ENCODING: Record<string, string> = { _: '%5F', '*': '%2A', '~': '%7E', '`': '%60' };
const BALANCED_UNDERSCORE_STRONG = /__([^_\n]+?)__/g;

function encodeUrlEntityMarkers(url: string): string {
  return url.replace(URL_ENTITY_MARKERS, (c) => URL_MARKER_ENCODING[c]);
}

export function hardenForTelegramV2(text: string): string {
  // 1) entity-marker chars inside link destinations and bare URLs → %-encoded
  let t = text.replace(LINK_DEST, (_m, url: string) => `](${encodeUrlEntityMarkers(url)})`);
  t = t.replace(BARE_URL, (m) => encodeUrlEntityMarkers(m));
  // 2) balanced __strong__ → **strong** (renders bold; output has no `__`)
  t = t.replace(BALANCED_UNDERSCORE_STRONG, '**$1**');
  // 3) leftover (unbalanced) `__` runs → escaped literals
  t = t.replace(/__+/g, (m) => m.replace(/_/g, '\\_'));
  return t;
}

export function telegramV1ToCommonMark(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // PATCH 22 first (URLs then contain no `*`, so bold promotion can't touch them)
  text = hardenForTelegramV2(text);
  text = text.replace(SINGLE_STAR_BOLD, '**$1**');

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
