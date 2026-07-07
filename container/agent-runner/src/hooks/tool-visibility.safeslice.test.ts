import { describe, it, expect } from 'bun:test';

import { safeSlice } from './tool-visibility';

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

describe('safeSlice (PATCH 23 — no half-emoji in previews)', () => {
  it('REGRESSION: cutting exactly inside an emoji drops the half instead of emitting a lone surrogate', () => {
    // Real production shape: preview line ended "… • 🔄 3 open-loops • \ud83d"
    // (emoji cut at MAX_INPUT_PREVIEW) → Telegram rejected the bubble AND all
    // later real messages on that chat with "text must be encoded in UTF-8".
    const line = 'x'.repeat(149) + '📊 rest';
    const cut = safeSlice(line, 150); // boundary lands between the surrogates
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut.length).toBe(149);
  });

  it('normal cuts are unchanged', () => {
    expect(safeSlice('hello world', 5)).toBe('hello');
    expect(safeSlice('héllo', 3)).toBe('hél');
    expect(safeSlice('📊📊', 4)).toBe('📊📊');
  });

  it('cut right AFTER a complete emoji keeps it', () => {
    expect(safeSlice('a📊b', 3)).toBe('a📊');
  });
});
