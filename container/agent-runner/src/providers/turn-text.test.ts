import { describe, it, expect } from 'bun:test';

import {
  extractMainAgentText,
  appendTurnText,
  resolveTurnDispatchText,
  countMessageOpenTags,
  type AssistantLikeMessage,
} from './turn-text';

// Simulate the SDK message stream for ONE turn and reduce it the way
// claude.ts's translateEvents now does.
function accumulate(stream: AssistantLikeMessage[]): string {
  let buf = '';
  for (const m of stream) buf = appendTurnText(buf, extractMainAgentText(m));
  return buf;
}

const asst = (blocks: Array<{ type: string; text?: string }>, parent: string | null = null): AssistantLikeMessage => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: blocks },
});

describe('turn-text accumulation (PATCH 11 — <message> lost after a trailing tool_use)', () => {
  it('REGRESSION: a <message> block emitted before a trailing tool_use is kept', () => {
    // Turn: assistant writes its reply (with the block) + a tool_use, then the
    // SDK runs the tool, then the model ends with a short non-<message> text.
    const stream: AssistantLikeMessage[] = [
      asst([
        { type: 'text', text: '<message to="Robby">Hier die Antwort.</message>' },
        { type: 'tool_use', text: undefined },
      ]),
      asst([{ type: 'tool_use', text: undefined }]),
      asst([{ type: 'text', text: '✅ fertig' }]),
    ];
    const turnText = accumulate(stream);
    const resultDotResult = '✅ fertig'; // what the SDK result.result would carry (final text only)

    // The OLD behavior (dispatch from result.result alone) loses the block:
    expect(resultDotResult).not.toContain('<message');
    // The FIX dispatches from the accumulated turn text → block preserved:
    const dispatched = resolveTurnDispatchText(turnText, resultDotResult);
    expect(dispatched).toContain('<message to="Robby">Hier die Antwort.</message>');
    expect(dispatched).toContain('✅ fertig');
  });

  it('keeps a single final <message> turn working (no regression)', () => {
    const turnText = accumulate([asst([{ type: 'text', text: '<message to="A">hi</message>' }])]);
    expect(resolveTurnDispatchText(turnText, '<message to="A">hi</message>')).toContain('<message to="A">hi</message>');
  });

  it('keeps MULTIPLE <message> blocks across separate assistant steps', () => {
    const turnText = accumulate([
      asst([{ type: 'text', text: '<message to="A">one</message>' }]),
      asst([{ type: 'tool_use' }]),
      asst([{ type: 'text', text: '<message to="B">two</message>' }]),
    ]);
    expect(turnText).toContain('<message to="A">one</message>');
    expect(turnText).toContain('<message to="B">two</message>');
  });

  it('ignores sub-agent (Task) assistant text — parent_tool_use_id set', () => {
    expect(extractMainAgentText(asst([{ type: 'text', text: 'sub-agent says hi' }], 'tool_xyz'))).toBe('');
  });

  it('ignores non-assistant and tool-only messages', () => {
    expect(extractMainAgentText({ type: 'user', message: { content: [{ type: 'text', text: 'x' }] } })).toBe('');
    expect(extractMainAgentText(asst([{ type: 'tool_use' }]))).toBe('');
  });

  it('falls back to result.result when no assistant text was captured', () => {
    expect(resolveTurnDispatchText('', 'final only')).toBe('final only');
    expect(resolveTurnDispatchText('', null)).toBeNull();
  });
});

describe('countMessageOpenTags (PATCH 11 loud-fail guard)', () => {
  it('counts well-formed and malformed opening tags', () => {
    expect(countMessageOpenTags('<message to="A">x</message>')).toBe(1);
    expect(countMessageOpenTags('<message to="A">x</message><message to="B">y</message>')).toBe(2);
    // Unclosed block still has an opening tag → guard will see openTags > matched
    expect(countMessageOpenTags('<message to="A">x   (no closing tag)')).toBe(1);
    expect(countMessageOpenTags('no blocks here')).toBe(0);
  });
});
