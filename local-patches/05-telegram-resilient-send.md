# Patch 05 — Resilient outbound Telegram send (plain-text fallback + 429 retry + logging)

**Applied:** 2026-06-13
**File:** `src/channels/telegram.ts`
**Backup:** `/tmp/telegram.ts.bak` (pre-edit copy on nano; also recoverable via `git checkout src/channels/telegram.ts`)
**Apply-script:** none (insert the `makeResilientTelegramSend` helper + wrap the `createTelegramAdapter(...)` call — see Diff)
**Diff:** `local-patches/05-telegram-resilient-send.diff`
**Upstream PR:** not yet filed — candidate (the real upstream fix is bumping `@chat-adapter/telegram` to >=4.30, which switches legacy `Markdown` → escaped `MarkdownV2`)

---

## Why

**Symptom:** Messages Andy sends to Telegram sometimes vanish completely — no delivery, and crucially **no error in the journal** (`journalctl -u nanoclaw-v2-454ebe7e` shows zero send errors despite repeated drops). User experiences it as the agent "ignoring" them; especially frequent for code/path/technical-heavy content.

**Root cause (traced 2026-06-13):**
1. NanoClaw sends with legacy Telegram **Markdown (V1)** parse mode. When the agent emits markdown the V1 sanitizer (`sanitizeTelegramLegacyMarkdown`) doesn't fully fix — a stray underscore in a path, nested `*`/`_`, an unbalanced backtick — Telegram rejects the **whole message** with HTTP 400 `can't parse entities`.
2. `@chat-adapter/telegram` correctly **throws** a typed `ValidationError` (and `AdapterRateLimitError` for 429), leaving the fallback policy to the consumer.
3. NanoClaw (the consumer) does **not** catch these throws: the rejection propagates through `enqueueOutbound` (which returns the rejecting promise) to a call site that neither retries nor logs it → **silent drop**.

Length-splitting (`maxTextLength: 4000`, Patch 01) and burst-serialization (PATCH 08) were already present — they are *not* the cause. The missing piece is parse-error resilience + observability.

---

## Patch summary

Adds a `makeResilientTelegramSend(adapter)` wrapper in `src/channels/telegram.ts` and applies it to the adapter before it is handed to `createChatSdkBridge`:

```ts
const telegramAdapter = makeResilientTelegramSend(
  createTelegramAdapter({ botToken: token, mode: 'polling' }),
);
```

The wrapper overrides `postMessage` so that:
1. **429 rate-limit** → wait `retry_after` (+250ms) then retry once.
2. **Any other failure with text** → retry once as **plain text** (markdown special chars `* _ \` [ ]` stripped). The message therefore **always arrives**, worst case unformatted, instead of disappearing.
3. **Every failure is logged** (`log.error`/`log.warn` with `tid` + error text) → a drop is never silent again.

Cards / file-only sends (no `markdown` text to downgrade) are logged and re-thrown unchanged (no plain-text fallback possible — parse errors there are not the drop path).

Verified: `tsc --noEmit` clean. No restart performed from the agent turn (the orchestrator runs Andy's own turn — see below).

---

## Deploy (EXTERNAL — never from Andy's turn)

The change is in `src/`; the live service runs built `dist/` (`ExecStart=node dist/index.js`). Editing src + typecheck does **not** affect the running orchestrator. To go live, **externally** (host-executor or Robby), not from an agent turn (restarting the orchestrator from the turn it runs = self-kill / no-recovery risk):

```bash
cd /root/nanoclaw-v2
./node_modules/.bin/tsc            # build dist
systemctl restart nanoclaw-v2-454ebe7e.service
systemctl is-active nanoclaw-v2-454ebe7e.service
# smoke: send a message with a deliberately markdown-breaking token (e.g. a stray underscore
# in backticks) and confirm it arrives as plain text + a log.error line appears.
```

**Rollback:** `git checkout src/channels/telegram.ts` (or restore `/tmp/telegram.ts.bak`) → rebuild → restart. The patch is additive and isolated to one file.

---

## Removal (when the clean fix lands)

The long-term fix is bumping `@chat-adapter/telegram` to >=4.30 (legacy `Markdown` → escaped `MarkdownV2`, which makes malformed markdown unable to 400) and dropping `sanitizeTelegramLegacyMarkdown`. After that bump is tested, remove this wrapper (revert the two hunks in this diff).
