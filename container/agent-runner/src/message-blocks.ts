/**
 * Parsing of the agent's `<message to="name">…</message>` output blocks
 * (PATCH 12). Pure + dependency-free so the tolerant-parsing and reminder
 * behaviour is unit-testable without the SDK / DB.
 *
 * BUG: when the model accidentally closed a `<message>` block with
 * `</parameter>` or `</invoke>` (tool-call syntax bleed) instead of
 * `</message>`, the strict parser matched nothing → the whole response was
 * discarded → "not delivered, re-send" reminder → the turn went idle and only
 * resumed on the next inbound event (cron / user msg) = minutes-long stalls.
 *
 * FIX: tolerant closing tag — accept `</message>`, `</parameter>` and
 * `</invoke>` as the block terminator. A single tag typo must not kill an
 * otherwise valid message.
 */

export interface ParsedBlock {
  to: string;
  body: string;
  start: number; // index of the opening `<message` in the source text
  end: number; // index just past the closing tag
}

// Tolerant closing tag: </message> | </parameter> | </invoke>.
const BLOCK_SOURCE = '<message\\s+to="([^"]+)"\\s*>([\\s\\S]*?)<\\/(?:message|parameter|invoke)>';

export function parseMessageBlocks(text: string): ParsedBlock[] {
  const re = new RegExp(BLOCK_SOURCE, 'g');
  const blocks: ParsedBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ to: m[1], body: m[2].trim(), start: m.index, end: re.lastIndex });
  }
  return blocks;
}

/** Count `<message …>` opening tags — for the malformed-block guard. */
export function countMessageBlockOpenTags(text: string): number {
  return (text.match(/<message\b[^>]*>/g) ?? []).length;
}

/**
 * Build the in-turn re-prompt reminder for a discarded response, naming the
 * ACTUAL problem (so the model can self-correct instead of repeating it) and
 * listing the valid destination names.
 */
export function buildRewrapReminder(unknownDestinations: string[], destinationNames: string[]): string {
  const names = destinationNames.join(', ');
  const reason = unknownDestinations.length
    ? `The destination name${unknownDestinations.length > 1 ? 's' : ''} ${unknownDestinations
        .map((n) => `"${n}"`)
        .join(', ')} ${unknownDestinations.length > 1 ? 'are' : 'is'} not valid.`
    : `Your response had no usable <message to="name">…</message> block (it may have been unwrapped, or a block was closed with the wrong tag such as </parameter> instead of </message>).`;
  return (
    `<system>Your last response was NOT delivered. ${reason} ` +
    `Wrap any content you want to send in <message to="name">…</message>, using EXACTLY one of these destination names: ${names}. ` +
    `Use <internal>…</internal> for scratchpad. Re-send your response now with the correct wrapping.</system>`
  );
}
