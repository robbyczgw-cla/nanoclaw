import { describe, it, expect } from 'vitest';
import { telegramV1ToCommonMark } from './telegram-markdown-v2.js';

describe('telegramV1ToCommonMark', () => {
  it('promotes single-* V1 bold to CommonMark **bold**', () => {
    expect(telegramV1ToCommonMark('*OK*')).toBe('**OK**');
    expect(telegramV1ToCommonMark('this is *very* important')).toBe('this is **very** important');
  });

  it('leaves existing **bold** untouched (no double promotion)', () => {
    expect(telegramV1ToCommonMark('**OK**')).toBe('**OK**');
  });

  it('leaves _italic_ alone (CommonMark italic survives to V2)', () => {
    expect(telegramV1ToCommonMark('a _d_ e')).toBe('a _d_ e');
  });

  it('does not touch * inside inline code spans', () => {
    const input = 'see `a*b*c` and `var_name` here';
    expect(telegramV1ToCommonMark(input)).toBe(input);
  });

  it('does not touch * inside fenced code blocks', () => {
    const input = '```\nfoo *bar* baz\n```';
    expect(telegramV1ToCommonMark(input)).toBe(input);
  });

  it('does not promote bullet "* " or arithmetic "2 * 3" (no non-space after open)', () => {
    expect(telegramV1ToCommonMark('* item one')).toBe('* item one');
    expect(telegramV1ToCommonMark('result 2 * 3 = 6')).toBe('result 2 * 3 = 6');
  });

  it('handles two bold spans on one line independently', () => {
    expect(telegramV1ToCommonMark('*a* and *b*')).toBe('**a** and **b**');
  });

  it('leaves an unpaired star alone (delegated to V2 escaper downstream)', () => {
    expect(telegramV1ToCommonMark('5 stars * here')).toBe('5 stars * here');
  });

  it('promotes bold but preserves an adjacent code span (the V1 nesting case)', () => {
    expect(telegramV1ToCommonMark('*Provenance* (aus `FORGED-BY.md`):')).toBe('**Provenance** (aus `FORGED-BY.md`):');
  });

  it('is a no-op on empty / falsy input', () => {
    expect(telegramV1ToCommonMark('')).toBe('');
  });
});

/**
 * PATCH 22 — regression tests against the REAL @chat-adapter/telegram
 * converter, reproducing the two live failure families from
 * logs/nanoclaw.error.log ("Can't find end of Underline entity" /
 * "Can't find end of a URL"). Red without hardenForTelegramV2, green with it.
 */
import { TelegramFormatConverter } from '@chat-adapter/telegram';
import { hardenForTelegramV2 } from './telegram-markdown-v2.js';

const converter = new TelegramFormatConverter();
const convert = (raw: string): string => converter.fromAst(converter.toAst(raw));

/**
 * Minimal model of Telegram's MarkdownV2 entity scanner — just enough to
 * reject what the Bot API rejects in our two failure families: an unclosed
 * `__` underline entity and an unterminated `](…` URL. Returns null if OK,
 * else a description.
 */
function findUnclosedEntity(text: string): string | null {
  let i = 0;
  let bold = false,
    italic = false,
    underline = false,
    strike = false,
    code = false;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      code = !code;
      i++;
      continue;
    }
    if (code) {
      i++;
      continue;
    }
    if (c === '_' && text[i + 1] === '_') {
      underline = !underline;
      i += 2;
      continue;
    }
    if (c === '_') {
      italic = !italic;
      i++;
      continue;
    }
    if (c === '*') {
      bold = !bold;
      i++;
      continue;
    }
    if (c === '~') {
      strike = !strike;
      i++;
      continue;
    }
    if (c === ']' && text[i + 1] === '(') {
      // URL entity: must terminate with an unescaped `)`
      let j = i + 2;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === ')') {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return `unterminated URL entity at ${i}`;
      i = j + 1;
      continue;
    }
    i++;
  }
  if (underline) return 'unclosed Underline entity';
  if (italic) return 'unclosed Italic entity';
  if (bold) return 'unclosed Bold entity';
  if (strike) return 'unclosed Strikethrough entity';
  if (code) return 'unclosed Code entity';
  return null;
}

// Real payload shape from the 2026-06 Underline failures (fable/sonnet style:
// nested/unbalanced __ emphasis).
const UNDERLINE_PAYLOAD =
  'Kurz: das alte Problem ist auf AzerothCore heute __weitgehend gelöst_ — aber mit Sternchen._\n\nHeute ist das anders.';

// Real payload shape from the URL failures: odd number of `_` across link
// destinations trips the adapter's safe-boundary trimmer into cutting MID-URL.
const URL_PAYLOAD =
  'Sources: [Generative Agents](https://github.com/joonspk-research/generative_agents) und bare https://github.com/a16z-infra/ai_town dazu.';

describe('hardenForTelegramV2 (PATCH 22)', () => {
  it('REGRESSION (a): unbalanced __ emphasis no longer yields adjacent underscores after conversion', () => {
    const out = convert(hardenForTelegramV2(UNDERLINE_PAYLOAD));
    expect(out).not.toMatch(/(?<!\\)__/);
    expect(findUnclosedEntity(out)).toBeNull();
  });

  it('REGRESSION (b): `_` in link URLs is %-encoded so the adapter trimmer cannot cut mid-URL', () => {
    const hardened = hardenForTelegramV2(URL_PAYLOAD);
    expect(hardened).toContain('generative%5Fagents');
    expect(hardened).toContain('ai%5Ftown');
    const out = convert(hardened);
    // No unescaped entity-marker underscores left anywhere → trimmer is a no-op.
    expect(out).not.toMatch(/(?<!\\)_/);
    expect(findUnclosedEntity(out)).toBeNull();
  });

  it('balanced __strong__ becomes bold (not underline) and survives conversion', () => {
    const out = convert(hardenForTelegramV2('das ist __wichtig__ hier'));
    expect(out).toContain('*wichtig*');
    expect(findUnclosedEntity(out)).toBeNull();
  });

  it('normal messages are untouched (no false positives)', () => {
    expect(hardenForTelegramV2('plain text with _italic_ and **bold**.')).toBe(
      'plain text with _italic_ and **bold**.',
    );
    expect(hardenForTelegramV2('Link ohne Marker: [a](https://example.com/path)')).toBe(
      'Link ohne Marker: [a](https://example.com/path)',
    );
  });

  it('telegramV1ToCommonMark leaves code spans with underscores/URLs untouched', () => {
    const input = 'see `github.com/a_b` and ```\nurl_with_under\n```';
    expect(telegramV1ToCommonMark(input)).toBe(input);
  });

  it('wikipedia-style parens URL keeps working', () => {
    const hardened = hardenForTelegramV2('https://en.wikipedia.org/wiki/Foo_(bar) ist gut');
    expect(hardened).toContain('Foo%5F(bar');
  });
});
