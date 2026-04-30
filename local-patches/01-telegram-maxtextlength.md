# Patch 01 — Telegram maxTextLength wiring

**Applied:** 2026-04-29
**File:** `src/channels/telegram.ts`
**Backup:** none required (1-line addition; trivially revertable)
**Apply-script:** none (manual 1-line edit — see "Apply" below)
**Diff:** `local-patches/01-telegram-maxtextlength.diff`
**Upstream PR:** [qwibitai/nanoclaw#2112](https://github.com/qwibitai/nanoclaw/pull/2112) — open

---

## Why

PR [qwibitai/nanoclaw#1900](https://github.com/qwibitai/nanoclaw/pull/1900) (merged 2026-04-21) added the `splitForLimit` helper and `maxTextLength` config option to `chat-sdk-bridge`, but explicitly noted that channel-adapter wiring would need a follow-up. That follow-up was never opened.

**Symptom without this patch:** Telegram messages over 4096 characters are silently truncated by the legacy `truncateMessage()` path. Long agent responses arrive as `…message…truncated…` with no warning to user or host. We hit this multiple times today before tracing it to PR #1900's missing wiring.

---

## Patch summary

Single-line addition inside `createChatSdkBridge` call:

```ts
const bridge = createChatSdkBridge({
  adapter: telegramAdapter,
  concurrency: 'concurrent',
  extractReplyContext,
  supportsThreads: false,
  transformOutboundText: sanitizeTelegramLegacyMarkdown,
  maxTextLength: 4000,   // ← LOCAL PATCH: PR #1900 follow-up wiring (no upstream fix yet)
});
```

`4000` leaves a 96-char safety buffer below Telegram's 4096-char hard limit (sanitizer escape sequences can grow the post-format string).

---

## Sample effect

**Before:** 6000-char agent response → silently cut at 4096 → user sees `"…rest never delivered"`
**After:** Same response → split at 4000 → 2 sequential Telegram messages (chunks); first message id is the reply head so reactions/edits still target the right message.

---

## Apply

If a `git pull` resets the file:

```bash
cd /root/nanoclaw-v2
sed -i 's|transformOutboundText: sanitizeTelegramLegacyMarkdown,|transformOutboundText: sanitizeTelegramLegacyMarkdown,\n      maxTextLength: 4000,|' src/channels/telegram.ts

# Build + restart
pnpm build
systemctl restart nanoclaw-v2-*.service
```

Verify:
```bash
grep maxTextLength src/channels/telegram.ts
# expected: 1 hit at the bridge call
```

Or apply the unified diff:
```bash
cd /root/nanoclaw-v2
patch -p0 < local-patches/01-telegram-maxtextlength.diff
```

---

## Verify still needed

Run before re-applying — upstream may have merged the wiring:

```bash
gh api repos/qwibitai/nanoclaw/contents/src/channels/telegram.ts --ref channels \
  --jq .content | base64 -d | grep -c maxTextLength
# 0  → upstream still missing wiring → re-apply this patch
# >=1 → upstream finally wired it → patch is OBSOLETE; delete this section + diff
```

---

## Notes

- Patch lives on the `channels` branch of upstream, not `main` — because `main` only has the setup-flow stubs for telegram. The runtime adapter source lives on `channels`.
- PR #2112 targets the `channels` branch as base.
- If/when #2112 merges, this patch becomes redundant. Verify before removing.
