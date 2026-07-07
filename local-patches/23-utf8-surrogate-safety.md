# Patch 23 — UTF-16 surrogate safety on the outbound path (chat-bricking fix)

**Files:** `src/channels/chat-sdk-bridge.ts`,
`container/agent-runner/src/hooks/tool-visibility.ts` (+ tests)
**Status:** 🟢 local-only (bridge part is an upstream candidate for vercel/chat consumers)
**Applied:** 2026-07-07

## Symptom

Andy's main Telegram DM went silent: every reply failed 3× with
`Bad Request: text must be encoded in UTF-8` and was permanently dropped —
including the plain-text fallback. Other chats kept working. 105 such errors
in the log since 2026-06-24 (first hits: gildenmeister), massive cluster on
the Andy chat starting 2026-07-07 01:31.

## Root cause (verified byte-for-byte)

`tool-visibility.ts`'s preview `truncate()` cut a line at
`MAX_INPUT_PREVIEW` **between the two halves of an emoji's UTF-16 surrogate
pair** (`tv-1783387914711-m0rq3e` ends `…🔄 3 open-loops • \ud83d`). A lone
surrogate cannot be encoded as UTF-8 → Telegram rejects the send. The
poisoned line lived in the bridge's in-memory tool-vis ACCUMULATOR, so:

1. every edit/flush/fresh-send of that bubble failed, and
2. — the killer — `finalizeToolVis` runs **unguarded before every real
   message** on the same chat (`chat-sdk-bridge.ts` sendMessage); its throw
   was attributed to the real message by the delivery retry loop, which gave
   up after 3 attempts. One half-emoji in one preview line bricked the whole
   chat until a host restart cleared the accumulator.

Stored message content was clean; the identical text sent fine from a fresh
process — that's how the in-memory poisoning was proven.

## Fix — three layers

1. **Source** (`tool-visibility.ts`): `safeSlice()` — every fixed-width
   preview truncation (150/80/60) backs off one unit when the cut lands on a
   lone high surrogate. No half-emoji can be produced anymore.
2. **Choke point** (`chat-sdk-bridge.ts`): `toWellFormedText()` (ES2024
   `String.prototype.toWellFormed` with regex fallback) applied inside
   `transformText` — ALL outbound text of every chat-sdk channel is
   guaranteed well-formed regardless of source. Also: `splitForLimit`'s hard
   cut backs off one unit at a surrogate boundary (same bug class in
   chunking).
3. **Blast-radius** (`chat-sdk-bridge.ts`): the pre-send
   `finalizeToolVis` call is now try/caught — a broken tool-vis bubble is
   logged and dropped, never again blocking the real reply.

## Verify

`grep -q toWellFormedText src/channels/chat-sdk-bridge.ts` and
`grep -q safeSlice container/agent-runner/src/hooks/tool-visibility.ts`.
Tests: `chat-sdk-bridge.test.ts` ("PATCH 23") + container
`tool-visibility.safeslice.test.ts` — both reproduce the real production
payload shape (red before, green after).

## Deploy notes

Host part: `pnpm run build` + service restart. Container part: volume-mounted
src → per-group container respawn. A host restart also clears any
already-poisoned accumulator (that was the immediate recovery on 2026-07-07).

## Re-apply after upstream reset

Re-apply `23-utf8-surrogate-safety.diff`; the three layers are independent —
the `transformText` sanitizer alone prevents the chat-bricking, the other two
restore preview fidelity and tool-vis resilience.
