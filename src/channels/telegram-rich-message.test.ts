import { describe, it, expect, vi } from 'vitest';
import {
  isTablePrimary,
  richTablesEnabled,
  richConstructsEnabled,
  hasRichOnlyConstruct,
  hasTDesktopCrashShape,
  stripCode,
  isRichCapabilityError,
  sendRichMessageRaw,
  editRichMessageRaw,
  chatIdFromTid,
  decodeRichEditTarget,
  hasDetailsFold,
  toolVisCollapseEnabled,
  buildCollapsedToolVis,
  RICH_MESSAGE_MAX_CHARS,
} from './telegram-rich-message.js';

const TABLE = ['| # | Titel | Typ |', '|---|-------|-----|', '| #1 | foo | bug |', '| #2 | bar | feature |'].join('\n');

describe('isTablePrimary', () => {
  it('detects a GFM pipe table', () => {
    expect(isTablePrimary(TABLE)).toBe(true);
    expect(isTablePrimary('Intro line\n\n' + TABLE + '\n\noutro')).toBe(true);
  });

  it('accepts loose dividers (no outer pipes, alignment colons)', () => {
    expect(isTablePrimary('a | b | c\n:--- | ---: | :--:\nx | y | z')).toBe(true);
  });

  it('rejects plain prose and bullet lists', () => {
    expect(isTablePrimary('just some text')).toBe(false);
    expect(isTablePrimary('- one\n- two\n- three')).toBe(false);
    expect(isTablePrimary('a | b')).toBe(false); // one pipe, no divider
  });

  it('rejects a single-dash line that is not a real divider', () => {
    expect(isTablePrimary('| a | b |\n| - | - |\n| 1 | 2 |')).toBe(false);
  });

  it('rejects rich constructs that need the full opt-in', () => {
    expect(isTablePrimary(TABLE + '\n- [ ] todo')).toBe(false); // task list
    expect(isTablePrimary(TABLE + '\n<details>\n</details>')).toBe(false); // collapsible
    expect(isTablePrimary(TABLE + '\n$$x^2$$')).toBe(false); // block math
  });

  it('rejects empty / pipe-free input fast', () => {
    expect(isTablePrimary('')).toBe(false);
    expect(isTablePrimary('no pipes here')).toBe(false);
  });
});

describe('stripCode — code-span/block exclusion (2026-06-28 copyability fix)', () => {
  it('removes fenced code blocks and inline code spans', () => {
    expect(stripCode('a `inline` b').trim()).toBe('a  b'.trim());
    expect(stripCode('x\n```\ncode\n```\ny').includes('code')).toBe(false);
  });
  it('makes a message DISCUSSING rich constructs not route to rich', () => {
    // the self-poisoning case: explaining the bug must stay copyable
    expect(hasRichOnlyConstruct('nur Tabellen + echte `<details>`-Folds, kein `##`')).toBe(false);
    expect(hasRichOnlyConstruct('a fenced example:\n```\n## heading\n---\n```\ntext')).toBe(false);
    expect(hasTDesktopCrashShape('docs: `<details>$$x$$</details>` in a span')).toBe(false);
  });
  it('still routes a REAL construct outside code', () => {
    expect(hasRichOnlyConstruct('## Real Heading\ntext')).toBe(true);
    expect(hasRichOnlyConstruct('<details><summary>x</summary>y</details>')).toBe(true);
  });
  it('still detects a REAL table outside code, ignores one shown in code', () => {
    expect(isTablePrimary('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    expect(isTablePrimary('example:\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```')).toBe(false);
  });
});

describe('hasRichOnlyConstruct (PATCH 18)', () => {
  it('matches MarkdownV2-impossible constructs', () => {
    expect(hasRichOnlyConstruct('## Heading\n\ntext')).toBe(true);
    expect(hasRichOnlyConstruct('# Title')).toBe(true);
    expect(hasRichOnlyConstruct('<details><summary>x</summary>y</details>')).toBe(true);
    expect(hasRichOnlyConstruct('above\n\n---\n\nbelow')).toBe(true); // hr
    expect(hasRichOnlyConstruct('text\n***\nmore')).toBe(true); // hr
    expect(hasRichOnlyConstruct('E = $$x^2$$')).toBe(true); // block math
    expect(hasRichOnlyConstruct('- [ ] todo\n- [x] done')).toBe(true); // task list
  });
  it('does NOT match plain MarkdownV2-renderable content', () => {
    expect(hasRichOnlyConstruct('*bold* and _italic_ and `code`')).toBe(false);
    expect(hasRichOnlyConstruct('- bullet one\n- bullet two')).toBe(false); // plain list
    expect(hasRichOnlyConstruct('> a blockquote')).toBe(false); // MarkdownV2 has quotes
    expect(hasRichOnlyConstruct('#hashtag without space')).toBe(false);
    expect(hasRichOnlyConstruct('a single - dash mid sentence')).toBe(false);
    expect(hasRichOnlyConstruct('')).toBe(false);
  });
});

describe('hasTDesktopCrashShape (PATCH 18)', () => {
  it('flags block math nested inside a <details> fold', () => {
    expect(hasTDesktopCrashShape('<details><summary>m</summary>\n$$x^2$$\n</details>')).toBe(true);
  });
  it('does not flag math outside details, or details without math', () => {
    expect(hasTDesktopCrashShape('$$x^2$$\n\n<details><summary>m</summary>plain</details>')).toBe(false);
    expect(hasTDesktopCrashShape('<details><summary>m</summary>plain text</details>')).toBe(false);
    expect(hasTDesktopCrashShape('just $$x^2$$ math')).toBe(false);
  });
});

describe('richConstructsEnabled (PATCH 18)', () => {
  it('defaults ON when unset', () => {
    expect(richConstructsEnabled({})).toBe(true);
    expect(richConstructsEnabled({ TELEGRAM_RICH_CONSTRUCTS: 'true' })).toBe(true);
  });
  it('is OFF for explicit falsey values', () => {
    for (const v of ['false', '0', 'off', 'no', 'FALSE']) {
      expect(richConstructsEnabled({ TELEGRAM_RICH_CONSTRUCTS: v })).toBe(false);
    }
  });
});

describe('richTablesEnabled', () => {
  it('defaults ON when unset', () => {
    expect(richTablesEnabled({})).toBe(true);
    expect(richTablesEnabled({ TELEGRAM_RICH_TABLES: 'true' })).toBe(true);
    expect(richTablesEnabled({ TELEGRAM_RICH_TABLES: '1' })).toBe(true);
  });
  it('is OFF for explicit falsey values', () => {
    for (const v of ['false', '0', 'off', 'no', 'FALSE', 'Off']) {
      expect(richTablesEnabled({ TELEGRAM_RICH_TABLES: v })).toBe(false);
    }
  });
});

describe('isRichCapabilityError', () => {
  it('treats 404 as a capability (latch-off) error', () => {
    expect(isRichCapabilityError({ errorCode: 404, message: 'Not Found' })).toBe(true);
  });
  it('treats unknown-method on the rich endpoint as capability error', () => {
    expect(isRichCapabilityError(new Error('Bad Request: unknown method sendRichMessage'))).toBe(true);
  });
  it('does NOT latch off on a per-message parser/400 error', () => {
    expect(isRichCapabilityError({ errorCode: 400, message: "Bad Request: can't parse rich_message" })).toBe(false);
  });
  it('does NOT latch off on per-message "not found" errors (the launch bug)', () => {
    // Our own error text contains "RichMessage" — must not be misread as a
    // capability error just because the message says "not found".
    expect(isRichCapabilityError(new Error('editRichMessage failed: 400 Bad Request: chat not found'))).toBe(false);
    expect(isRichCapabilityError(new Error('editRichMessage failed: 400 Bad Request: message to edit not found'))).toBe(
      false,
    );
    expect(isRichCapabilityError(new Error('sendRichMessage failed: 400 Bad Request: chat not found'))).toBe(false);
  });
});

describe('decodeRichEditTarget', () => {
  it('decodes the adapter composite <chatId>:<messageId> form', () => {
    expect(decodeRichEditTarget('7754134287:21037', 'telegram:7754134287')).toEqual({
      chatId: 7754134287,
      messageId: 21037,
    });
    expect(decodeRichEditTarget('-1001234567890:567', 'telegram:-1001234567890')).toEqual({
      chatId: -1001234567890,
      messageId: 567,
    });
  });
  it('falls back to the thread id chat when the message id is bare', () => {
    expect(decodeRichEditTarget('21037', 'telegram:7754134287')).toEqual({
      chatId: 7754134287,
      messageId: 21037,
    });
  });
});

describe('sendRichMessageRaw', () => {
  it('POSTs raw markdown to sendRichMessage and returns a RawMessage', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 4242 } }),
    })) as unknown as typeof fetch;

    const out = await sendRichMessageRaw({ token: 'T', fetchImpl }, '-100123', TABLE, 99);

    expect(out).toEqual({ id: '4242', raw: { message_id: 4242 }, threadId: '-100123' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/botT/sendRichMessage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe(-100123); // numeric chat_id
    expect(body.rich_message).toEqual({ markdown: TABLE }); // RAW markdown, not escaped
    expect(body.reply_parameters).toEqual({ message_id: 99 });
  });

  it('throws (caller falls back) on ok:false, tagging the error code', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 404, description: 'Not Found' }),
    })) as unknown as typeof fetch;

    await expect(sendRichMessageRaw({ token: 'T', fetchImpl }, '123', TABLE)).rejects.toMatchObject({
      errorCode: 404,
    });
  });

  it('respects the rich char cap constant', () => {
    expect(RICH_MESSAGE_MAX_CHARS).toBe(32768);
  });
});

// ── PATCH 17 ────────────────────────────────────────────────────────────────

describe('editRichMessageRaw', () => {
  it('POSTs editMessageText with a rich_message payload', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    })) as unknown as typeof fetch;

    const md = '<details><summary>🔧 2 Tool-Calls — aufklappen</summary>\n\n- a\n- b\n\n</details>';
    const out = await editRichMessageRaw({ token: 'T', fetchImpl }, '-100123', '77', md);

    expect(out).toEqual({ id: '77', raw: { message_id: 77 }, threadId: '-100123' });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/botT/editMessageText');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe(-100123);
    expect(body.message_id).toBe(77);
    expect(body.rich_message).toEqual({ markdown: md });
  });

  it('decodes a composite <chatId>:<messageId> id into chat_id + message_id', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { message_id: 21037 } }),
    })) as unknown as typeof fetch;
    await editRichMessageRaw(
      { token: 'T', fetchImpl },
      'telegram:7754134287',
      '7754134287:21037',
      '<details></details>',
    );
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as { body: string }).body);
    expect(body.chat_id).toBe(7754134287);
    expect(body.message_id).toBe(21037);
  });

  it('keeps the original message_id when result is the boolean true', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: true, result: true }),
    })) as unknown as typeof fetch;
    const out = await editRichMessageRaw({ token: 'T', fetchImpl }, '123', '55', '<details></details>');
    expect(out.id).toBe('55');
  });

  it('throws (caller falls back) on ok:false, tagging the error code', async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ ok: false, error_code: 404, description: 'Not Found' }),
    })) as unknown as typeof fetch;
    await expect(editRichMessageRaw({ token: 'T', fetchImpl }, '1', '2', '<details></details>')).rejects.toMatchObject({
      errorCode: 404,
    });
  });
});

describe('chatIdFromTid', () => {
  it('strips the bridge `telegram:` prefix to a numeric chat_id', () => {
    expect(chatIdFromTid('telegram:7754134287')).toBe(7754134287);
    expect(chatIdFromTid('telegram:-1001234567890')).toBe(-1001234567890);
  });
  it('accepts a bare numeric id (no prefix)', () => {
    expect(chatIdFromTid('7754134287')).toBe(7754134287);
    expect(chatIdFromTid('-100123')).toBe(-100123);
  });
  it('leaves a non-numeric id as a string', () => {
    expect(chatIdFromTid('telegram:@channelname')).toBe('@channelname');
  });
});

describe('hasDetailsFold', () => {
  it('detects a <details> fold and ignores anything else', () => {
    expect(hasDetailsFold('<details><summary>x</summary>y</details>')).toBe(true);
    expect(hasDetailsFold('<DETAILS>')).toBe(true);
    expect(hasDetailsFold('just text')).toBe(false);
    expect(hasDetailsFold(TABLE)).toBe(false);
  });
});

describe('toolVisCollapseEnabled', () => {
  it('defaults ON when unset', () => {
    expect(toolVisCollapseEnabled({})).toBe(true);
    expect(toolVisCollapseEnabled({ TELEGRAM_TOOLVIS_COLLAPSE: 'true' })).toBe(true);
  });
  it('is OFF for explicit falsey values', () => {
    for (const v of ['false', '0', 'off', 'no', 'FALSE']) {
      expect(toolVisCollapseEnabled({ TELEGRAM_TOOLVIS_COLLAPSE: v })).toBe(false);
    }
  });
});

describe('buildCollapsedToolVis', () => {
  it('wraps lines in a <details> fold with a counted, singular/plural summary', () => {
    const one = buildCollapsedToolVis(['🔧 ssh check']);
    expect(one).toContain('<details><summary>🔧 1 Tool-Call — aufklappen</summary>');
    expect(one).toContain('🔧 ssh check');
    expect(one.endsWith('</details>')).toBe(true);

    const many = buildCollapsedToolVis(['🔧 a', '🔧 b', '🔧 c']);
    expect(many).toContain('🔧 3 Tool-Calls — aufklappen');
  });

  it('drops blank lines from the count and body', () => {
    const out = buildCollapsedToolVis(['🔧 a', '   ', '', '🔧 b']);
    expect(out).toContain('2 Tool-Calls');
  });

  it('returns empty string for no usable lines (caller skips the collapse)', () => {
    expect(buildCollapsedToolVis([])).toBe('');
    expect(buildCollapsedToolVis(['', '  '])).toBe('');
  });
});
