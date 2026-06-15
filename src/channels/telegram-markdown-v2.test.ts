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
