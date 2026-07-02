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

const OPEN_TAG = /<message\s+to="([^"]+)"\s*>/g;
const CLOSE_MESSAGE = '</message>';
// PATCH 13: only a </parameter> / </invoke> sitting at the TRUE END of the
// (trimmed) block body counts as an accidental closer.
const TRAILING_STRAY_CLOSE = /<\/(?:parameter|invoke)>$/;

export function parseMessageBlocks(text: string): ParsedBlock[] {
  // Collect all opening tags first so each block's region is bounded by the
  // next opening (a no-</message> block can't swallow the following block).
  const opens: Array<{ to: string; start: number; bodyStart: number }> = [];
  const openRe = new RegExp(OPEN_TAG.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text)) !== null) {
    opens.push({ to: m[1], start: m.index, bodyStart: openRe.lastIndex });
  }

  const blocks: ParsedBlock[] = [];
  for (let i = 0; i < opens.length; i++) {
    const cur = opens[i];
    const regionEnd = i + 1 < opens.length ? opens[i + 1].start : text.length;

    // PATCH 13 — PRIMARY: prefer a real </message>. If one exists in this
    // block's region, EVERYTHING before it is the body — including any
    // </parameter>/</invoke> the model quoted in the text. Never cut at a
    // body tag when a real closer is present.
    const closeIdx = text.indexOf(CLOSE_MESSAGE, cur.bodyStart);
    if (closeIdx !== -1 && closeIdx < regionEnd) {
      blocks.push({
        to: cur.to,
        body: text.slice(cur.bodyStart, closeIdx).trim(),
        start: cur.start,
        end: closeIdx + CLOSE_MESSAGE.length,
      });
      continue;
    }

    // PATCH 13 — FALLBACK (no </message>): take the whole region as body and
    // strip ONLY a stray </parameter>/</invoke> at the TRUE END. A mid-body
    // occurrence (e.g. the tag name quoted in backticks) is kept.
    const body = text.slice(cur.bodyStart, regionEnd).trim().replace(TRAILING_STRAY_CLOSE, '').trimEnd();
    blocks.push({ to: cur.to, body, start: cur.start, end: regionEnd });
  }
  return blocks;
}

/** Count `<message …>` opening tags — for the malformed-block guard. */
export function countMessageBlockOpenTags(text: string): number {
  return (text.match(/<message\b[^>]*>/g) ?? []).length;
}

/**
 * PATCH 21 — best-effort salvage of an unwrapped reply.
 *
 * When a turn ends with zero deliverable <message> blocks, the root cause is
 * almost always that the model never TYPED the wrapper (verified against raw
 * API transcripts: 8/9 production failures had zero `<message` opening tags
 * anywhere in the turn — the accumulation pipeline loses nothing). The final
 * assistant text chunk in those turns IS the intended user-facing reply, so
 * instead of dropping it (or burning re-prompt turns), the poll-loop delivers
 * it directly after cleaning it up here.
 *
 * Cleanup: remove any <message ...> opening-tag remnants (covers the
 * attribute-less / unclosed variants the tolerant parser can't bind to a
 * destination), remove </message> closers, and — mirroring PATCH 13 — strip a
 * stray </parameter>/</invoke> only at the TRUE END of the text. Caller is
 * expected to have stripped <internal> blocks already (stripInternalTags).
 * Returns null when nothing user-facing remains.
 */
export function salvageUnwrappedReply(text: string): string | null {
  const cleaned = text
    .replace(/<message\b[^>]*>/g, '')
    .replace(/<\/message>/g, '')
    .trim()
    .replace(TRAILING_STRAY_CLOSE, '')
    .trimEnd();
  return cleaned.length > 0 ? cleaned : null;
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
