import { describe, it, expect } from 'bun:test';

import { parseMessageBlocks, countMessageBlockOpenTags, buildRewrapReminder, salvageUnwrappedReply } from './message-blocks';

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

describe('parseMessageBlocks — tail-strip, no mid-body cut (PATCH 13)', () => {
  it('(a) REGRESSION: body QUOTES the tag in backticks AND ends with a stray </parameter> — full body kept, only trailing tag stripped', () => {
    // The exact 2026-06-17 ground truth: a confirmation that mentioned the tag
    // name in backticks and (accidentally) closed with the same tag.
    const text = '<message to="Robby">✅ Bin wieder da — auf Patch-12-Code (tolerantes `</parameter>`/`</invoke>` Parsing) — fertig.</parameter>';
    const blocks = parseMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('✅ Bin wieder da — auf Patch-12-Code (tolerantes `</parameter>`/`</invoke>` Parsing) — fertig.');
    // crucially: NOT cut at the first backtick-quoted </parameter>
    expect(blocks[0].body).toContain('`</parameter>`');
    expect(blocks[0].body).toContain('fertig.');
  });

  it('(b) body QUOTES the tag but closes correctly with </message> — quoted tag stays in the text', () => {
    const text = '<message to="Robby">use `</parameter>` to close a tool param, ok?</message>';
    const blocks = parseMessageBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('use `</parameter>` to close a tool param, ok?');
  });

  it('(c) normal </message> is unchanged', () => {
    expect(parseMessageBlocks('<message to="A">plain answer</message>')[0].body).toBe('plain answer');
  });

  it('strips a trailing stray closer with trailing whitespace too', () => {
    expect(parseMessageBlocks('<message to="A">hi</invoke>  ')[0].body).toBe('hi');
  });

  it('does NOT strip a </parameter> that is mid-body when there is no real closer', () => {
    // tag quoted mid-body, block ends with plain text (no closer at all)
    const [b] = parseMessageBlocks('<message to="A">the `</parameter>` token is XML</invoke>');
    expect(b.body).toBe('the `</parameter>` token is XML');
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

describe('salvageUnwrappedReply (PATCH 21)', () => {
  it('returns bare reply text unchanged (trimmed)', () => {
    expect(salvageUnwrappedReply('  Hier die Antwort.  ')).toBe('Hier die Antwort.');
  });

  it('strips attribute-less / unclosed <message> tag remnants', () => {
    expect(salvageUnwrappedReply('<message>Antwort ohne to')).toBe('Antwort ohne to');
    expect(salvageUnwrappedReply('<message to="x">Antwort unclosed')).toBe('Antwort unclosed');
    expect(salvageUnwrappedReply('<message to="x">Antwort</message>')).toBe('Antwort');
  });

  it('strips a stray trailing </parameter> / </invoke> but keeps mid-body mentions', () => {
    expect(salvageUnwrappedReply('Antwort</parameter>')).toBe('Antwort');
    expect(salvageUnwrappedReply('Nutze `</parameter>` als Tag — so gehts.')).toBe(
      'Nutze `</parameter>` als Tag — so gehts.',
    );
  });

  it('returns null for empty / whitespace-only / tag-only input', () => {
    expect(salvageUnwrappedReply('')).toBeNull();
    expect(salvageUnwrappedReply('   \n ')).toBeNull();
    expect(salvageUnwrappedReply('<message to="x"></message>')).toBeNull();
  });
});
