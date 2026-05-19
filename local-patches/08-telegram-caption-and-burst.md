# Patch 08 — Telegram caption chunking + per-chat outbound queue

**Applied:** 2026-05-19
**Files:** `src/channels/chat-sdk-bridge.ts`, `src/channels/telegram.ts`
**Backup:** none required (additive — idempotent string-replace)
**Apply-script:** `local-patches/08-apply.py`
**Diff:** `local-patches/08-telegram-caption-and-burst.diff`
**Upstream PR:** none (local-only; would need a separate PR per concern if upstreamed)

---

## Why

Patch 01 added `maxTextLength: 4000` wiring for Telegram, which split single long `<message>` blocks into chunks below Telegram's 4096-char `sendMessage.text` limit. But two failure modes weren't covered by that wiring:

### 1. File-attachment captions get silently truncated

`send_file({ text: "..." })` rides the text as a **file caption** through `sendDocument.caption`, which Telegram caps at **1024 chars** (not 4096). The chunking in chat-sdk-bridge sent the whole first chunk (up to 4000 chars) as the file caption — Telegram silently dropped everything past 1024.

**Symptom seen on 2026-05-19 22:14:** A `send_file` companion-message of ~2500 chars arrived with the bottom 1500 chars cut off. User confirmed with "Wtf abgeschnitten schon wieder".

### 2. Multi-message bursts silently dropped

When the agent emits 3+ `<message>` blocks in one response, the host fires separate `send_message` MCP tool calls. The chat-sdk-bridge processes them via separate `deliver` invocations that can run in parallel. Telegram's per-chat send rate (~1 msg/sec sustained) then drops or merges some sends with no error.

**Symptom seen on 2026-05-19 16:30:** A 4-message audit report was sent. None arrived. User confirmed with "habe nichts bekommen wtf?".

---

## Patch summary

Two additive changes in `chat-sdk-bridge.ts` + one wiring in `telegram.ts`.

### Change 1 — caption-aware chunking

New optional bridge config `maxCaptionLength`. When set AND the outbound message has files attached, the first chunk (which rides as the caption) is sized against `maxCaptionLength` instead of `maxTextLength`. The rest of the text overflows into subsequent regular text chunks at `maxTextLength`.

```ts
// before
const chunks = config.maxTextLength && text.length > config.maxTextLength
  ? splitForLimit(text, config.maxTextLength)
  : [text];

// after
const hasFiles = !!fileUploads && fileUploads.length > 0;
const firstChunkLimit = hasFiles && config.maxCaptionLength
  ? config.maxCaptionLength
  : config.maxTextLength;
const restChunkLimit = config.maxTextLength;
let chunks: string[];
if (firstChunkLimit && text.length > firstChunkLimit) {
  const head = splitForLimit(text, firstChunkLimit)[0];
  const tail = text.slice(head.length).replace(/^\s+/, '');
  const tailChunks = tail
    ? (restChunkLimit && tail.length > restChunkLimit
       ? splitForLimit(tail, restChunkLimit) : [tail])
    : [];
  chunks = [head, ...tailChunks];
} else {
  chunks = [text];
}
```

### Change 2 — per-thread outbound queue

Module-level queue keyed by `tid`. Each call to `deliver(...)` chains onto the previous in-flight delivery for the same thread, with a 200ms pacing delay between consecutive sends. Different threads run in parallel; same-thread sends are sequential.

```ts
const outboundQueues = new Map<string, Promise<unknown>>();
const OUTBOUND_PACING_MS = 200;

function enqueueOutbound<T>(tid: string, fn: () => Promise<T>): Promise<T> {
  const prev = outboundQueues.get(tid) ?? Promise.resolve();
  const next = prev
    .then(() => new Promise<void>((r) => setTimeout(r, OUTBOUND_PACING_MS)))
    .then(fn);
  outboundQueues.set(tid, next.catch(() => {}));
  return next;
}
```

The `deliver` body is wrapped in `return enqueueOutbound(tid, async () => { ... })`.

### Change 3 — wire `maxCaptionLength: 1000`

Single-line addition in `telegram.ts`:

```ts
const bridge = createChatSdkBridge({
  // ...
  maxTextLength: 4000,
  maxCaptionLength: 1000,  // ← PATCH 08
});
```

`1000` leaves a 24-char safety buffer below Telegram's 1024-char caption hard limit (markdown escape sequences can grow the post-format string).

---

## Sample effect

**Before patch 08:**
- `send_file({ text: 2500-char-caption, ... })` → telegram receives file with 1024 chars caption, rest dropped silently
- 4× `<message>` in one response → some or all dropped silently

**After patch 08:**
- `send_file({ text: 2500-char-caption, ... })` → file with first ~1000 chars as caption, remaining ~1500 chars arrive as a follow-up text message
- 4× `<message>` in one response → all 4 delivered sequentially with 200ms pacing, none dropped

---

## Apply

Run from the `nanoclaw-v2` checkout root:

```bash
cd /root/nanoclaw-v2
python3 local-patches/08-apply.py
pnpm build
# Do NOT systemctl restart from inside the agent — see "Service-restart" below
```

Verify:

```bash
grep -q 'maxCaptionLength: 1000' src/channels/telegram.ts \
  && grep -q 'enqueueOutbound' src/channels/chat-sdk-bridge.ts \
  && echo "patch 08 applied"
```

Or run the full check:

```bash
bash local-patches/verify.sh
```

---

## Service-restart caveat

If the patched code needs the service to reload, **do not** run `systemctl restart nanoclaw-v2-<hash>.service` synchronously from inside the agent — the agent host process IS the service, so a synchronous restart kills the agent mid-action and triggers a re-resume loop. Use a delayed fire-and-forget pattern:

```bash
systemd-run --no-block --on-active=15sec /bin/systemctl restart nanoclaw-v2-<hash>.service
```

The agent then has ~15 seconds to deliver its final reply before being killed cleanly.

---

## Idempotency + safety

Both transforms in `08-apply.py` check for sentinel markers (`maxCaptionLength?: number`, `enqueueOutbound`, `PATCH 08: caption-aware chunking`, `PATCH08_CLOSE_DELIVER`) before applying. Re-running the script is a no-op once the patch is in place. The diff is purely additive — original semantics for text-only messages without files are unchanged (the new chunk-selection branch reduces to the old behavior when `hasFiles === false`).
