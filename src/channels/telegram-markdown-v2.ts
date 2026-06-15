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

export function telegramV1ToCommonMark(input: string): string {
  if (!input) return input;

  const codeSegments: string[] = [];
  let text = input.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  text = text.replace(SINGLE_STAR_BOLD, '**$1**');

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
