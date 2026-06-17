import { describe, it, expect } from 'bun:test';

import { parseMessageBlocks, countMessageBlockOpenTags, buildRewrapReminder } from './message-blocks';

describe('parseMessageBlocks — tolerant closing tag (PATCH 12, turn-stall fix)', () => {
  it('REGRESSION: a block closed with </parameter> instead of </message> is parsed (not discarded)', () => {
    // The exact reported failure: tool-call syntax bleed on the closing tag.
    const text = '<message to="Robby">Hier die Antwort.</parameter>';
    const blocks = parseMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].to).toBe('Robby');
    expect(blocks[0].body).toBe('Hier die Antwort.');
  });

  it('also tolerates </invoke> as a closing tag', () => {
    const blocks = parseMessageBlocks('<message to="Robby">done</invoke>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('done');
  });

  it('still parses a correct </message> block (no regression)', () => {
    const blocks = parseMessageBlocks('<message to="Robby">hi</message>');
    expect(blocks).toEqual([{ to: 'Robby', body: 'hi', start: 0, end: 'hi</message>'.length + '<message to="Robby">'.length }]);
  });

  it('parses multiple blocks with mixed closing tags', () => {
    const blocks = parseMessageBlocks('<message to="A">one</message> <message to="B">two</parameter>');
    expect(blocks.map((b) => [b.to, b.body])).toEqual([
      ['A', 'one'],
      ['B', 'two'],
    ]);
  });

  it('returns [] for text with no blocks', () => {
    expect(parseMessageBlocks('just some plain text')).toEqual([]);
  });

  it('exposes positions so callers can reconstruct the scratchpad gaps', () => {
    const text = 'before <message to="A">x</message> after';
    const [b] = parseMessageBlocks(text);
    expect(text.slice(0, b.start)).toBe('before ');
    expect(text.slice(b.end)).toBe(' after');
  });
});

describe('countMessageBlockOpenTags (PATCH 11 guard, retained)', () => {
  it('counts opening tags regardless of closing tag', () => {
    expect(countMessageBlockOpenTags('<message to="A">x</parameter>')).toBe(1);
    expect(countMessageBlockOpenTags('<message to="A">x</message><message to="B">y</message>')).toBe(2);
    expect(countMessageBlockOpenTags('no blocks')).toBe(0);
  });
});

describe('buildRewrapReminder — specific feedback (PATCH 12)', () => {
  it('names the unknown destination and lists valid ones', () => {
    const r = buildRewrapReminder(['telegram'], ['Robby', 'Cami']);
    expect(r).toContain('"telegram"');
    expect(r).toContain('is not valid');
    expect(r).toContain('Robby, Cami');
  });

  it('handles the no-block case with generic-but-actionable guidance', () => {
    const r = buildRewrapReminder([], ['Robby']);
    expect(r).toContain('no usable <message');
    expect(r).toContain('</parameter>'); // hints at the common typo
    expect(r).toContain('Robby');
  });

  it('pluralizes multiple unknown destinations', () => {
    const r = buildRewrapReminder(['a', 'b'], ['Robby']);
    expect(r).toContain('"a", "b"');
    expect(r).toContain('are not valid');
  });
});
