# Local patches — nanoclaw-v2

This directory tracks every local source-code modification applied to `/root/nanoclaw-v2`. Each patch documents the upstream issue, the change, why it's still needed, and how to re-apply it after a `git pull` or `pnpm install` resets the file.

**The single rule:** when you make a code-change to `/root/nanoclaw-v2/**`, document it here *before* you forget. A 5-minute write-up now saves a 30-minute archaeology session in 6 weeks when you've upgraded.

---

## Active patches

| # | File | Title | Upstream PR | Status |
|---|------|-------|-------------|--------|
| 01 | `src/channels/telegram.ts` | Telegram maxTextLength wiring | [qwibitai/nanoclaw#2112](https://github.com/qwibitai/nanoclaw/pull/2112) | 🟡 awaiting review |
| 02 | `container/agent-runner/src/hooks/tool-visibility.ts` | Tool-visibility v0.x polish | none (deferred) | 🟢 local-only |
| 03 | `container/agent-runner/src/hooks/tool-visibility.ts` | Tool-visibility v0.y (failure + shape) | none (deferred) | 🟢 local-only |
| 04 | `tool-visibility.ts` + `chat-sdk-bridge.ts` | Tool-vis accumulator (Telegram edit-in-place) | none (deferred) | 🟢 local-only |
| 05 | `tool-visibility.ts` | Tool-vis v1.0 (bash preview + code-fence + iter progress) | none (deferred) | 🟢 local-only |
| 06 | `tool-visibility.ts` | Tool-vis v1.1 (bash-prefix + task-suppress + cache-fix) | none (deferred) | 🟢 local-only |
| 07 | `tool-visibility.ts` | Empty TodoWrite suppress (`📝 todo · 0 tasks` noise) | none (deferred) | 🟢 local-only |
| 08 | `src/channels/chat-sdk-bridge.ts` + `src/channels/telegram.ts` | Telegram caption chunking + per-chat outbound queue | none (local-only) | 🟢 local-only |
| 09 | `src/channels/chat-sdk-bridge.ts` | Tool-vis edit coalescing (debounce bubble edits + finalize flush) | none (local-only) | 🟢 local-only |
| 10 | `container/agent-runner/src/hooks/tool-visibility.ts` | Tool-vis task-session fix (classify on current batch, not global-latest row) | none (local-only) | 🟢 local-only |
| 11 | `container/agent-runner/src/providers/{claude,turn-text}.ts` + `poll-loop.ts` | `<message>` block enqueue fix (dispatch full turn text, not just result.result) | none (local-only) | 🟢 local-only |
| 12 | `container/agent-runner/src/{message-blocks,poll-loop}.ts` | Turn-stall fix (tolerant `</parameter>`/`</invoke>` parse + capped in-turn re-prompt + specific feedback) | none (local-only) | 🟢 local-only |
| 13 | `container/agent-runner/src/message-blocks.ts` | Tolerant parse tail-strip (no mid-body cut on a quoted `</parameter>`/`</invoke>`) | none (local-only) | 🟢 local-only |
| 14 | `container/skills/learn/SKILL.md` | `/learn` as a runtime skill in agent containers (copied from `.claude/skills/`, which isn't mounted into containers) | none (upstream ships it only at dev level) | 🟢 local-only |
| 15 | `container/agent-runner/src/providers/claude.ts` | Local default model (`claude-opus-4-8`, was stale `claude-opus-4-7[1m]`) + auto-compact window (`900000`, upstream `165000`) | none (upstream has neither) | 🟢 local-only |
| 16 | `src/channels/telegram-rich-message.ts` (new) + `telegram.ts` | Native Telegram tables via Bot API 10.1 `sendRichMessage` (table-primary auto-route, MarkdownV2 fallback) | candidate (generic) | 🟢 local-only |
| 17 | `src/channels/{telegram-rich-message,telegram,chat-sdk-bridge}.ts` | Collapse tool-vis timeline into a `<details>` fold on turn-end (`editMessageText`+`rich_message`) | none (rides on local PATCH 09) | 🟢 local-only |
| 18 | `src/channels/telegram-rich-message.ts` + `telegram.ts` | Broaden rich routing to MarkdownV2-impossible constructs (headings, `<details>`, dividers, block math, task lists) + TDesktop crash-guard | candidate (generic) | 🟢 local-only |
| 20 | `container/agent-runner/src/mcp-tools/core.ts` | Selectively eager-load core reply tools (`send_message`/`send_file`/`edit_message`/`add_reaction` via `_meta['anthropic/alwaysLoad']`) so Sonnet-5 doesn't loop on `ToolSearch` for `send_message` | candidate (generic) | 🟢 local-only |
| 21 | `container/agent-runner/src/{poll-loop,message-blocks,providers/claude,providers/types}.ts` | Fallback delivery for unwrapped replies — model omits the `<message>` wrapper after long tool chains (verified in raw API transcripts); final text chunk is salvaged + delivered instead of re-prompt-looped. Consolidates the 11/12/13 delivery-robustness theme | candidate (generic) | 🟢 local-only |

**Apply order matters:** 02 must be applied before 03 — 03's apply-script anchors on strings introduced by 02. Patch 01 is independent of 02/03.

---

## Layout

```
local-patches/
├── README.md                                    ← this file
├── 01-telegram-maxtextlength.md                  ← full doc per patch
├── 01-telegram-maxtextlength.diff                ← unified diff for `patch -p0`
├── 02-tool-visibility-v0x.md
├── 02-tool-visibility-v0x.diff
├── 02-tool-visibility-v0x.py                     ← idempotent apply-script (string-replace based)
├── 03-tool-visibility-v0y.md
├── 03-tool-visibility-v0y.diff
└── 03-tool-visibility-v0y.py
```

Each patch has both a `.diff` (unified diff, fastest re-apply) and (where applicable) a `.py` script (string-replace based, idempotent — can be re-run safely on partially-applied source). Use the diff when the surrounding context is unchanged; use the script when the file structure has drifted but anchor strings still exist.

---

## Re-apply workflow (post-update)

After every `git pull` or `pnpm install`:

```bash
cd /root/nanoclaw-v2

# 1. Verify which patches are still present
bash local-patches/verify.sh

# 2. Re-apply any missing ones (in numeric order)
for diff in local-patches/*.diff; do
  patch -p0 --dry-run --reverse < "$diff" >/dev/null 2>&1 \
    && echo "✅ $(basename $diff) already applied" \
    || patch -p0 < "$diff"
done

# 3. tsc check
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec tsc --noEmit  # host-side

# 4. Build (host code only — agent-runner runs source directly via Bun)
pnpm build

# 5. Restart host service (this kills running agent containers — schedule accordingly)
systemctl restart nanoclaw-v2-*.service
```

---

## When upstream merges a patch

When an upstream PR for one of these patches merges:

1. Pull the latest upstream code (`git fetch upstream && git merge upstream/main`)
2. Run `patch -p0 --dry-run < local-patches/NN-*.diff` — if it reports "already applied" or "skipping patch", upstream now has the fix
3. Update this README's status column → 🟢 → ⚫ merged-upstream
4. Move the patch files (`.md`, `.diff`, `.py`) to `local-patches/_merged/` (create if missing) — keep them as historical reference, but they no longer need to be re-applied
5. Update the verify-script if relevant

---

## When NOT to add a patch here

Do NOT add to `local-patches/`:
- Configuration changes (those go in `lucid.config.json` / `.env` / DB rows)
- Per-group `CLAUDE.local.md` content
- Skill installs (those persist in `groups/<g>/CLAUDE.local.md` or skill repos)
- Anything in `data/` or `groups/` — those are state, not code

Patches are only for **source-code modifications under `/root/nanoclaw-v2/{src,container,setup,scripts}`** that would otherwise be wiped by an upstream update.

---

## Verifying you're up to date

Quick health check:

```bash
# Are all 3 patches present in the running source?
grep -c 'maxTextLength: 4000' /root/nanoclaw-v2/src/channels/telegram.ts                                    # expected: 1
grep -c 'formatToolLine' /root/nanoclaw-v2/container/agent-runner/src/hooks/tool-visibility.ts              # expected: 6+ (calls + def)
grep -c 'detectFailureFromResponse' /root/nanoclaw-v2/container/agent-runner/src/hooks/tool-visibility.ts   # expected: 2 (call + def)
```

If any return 0, the patch was wiped — re-apply via the workflow above.

---

## History (newest first)

- **2026-06-27** — Patch 15 applied (claude.ts local defaults: bumped the hardcoded default-model fallback `claude-opus-4-7[1m]` → `claude-opus-4-8` — 4.8 is 1M-context by default at the same price, no `[1m]` suffix needed; also formalized the pre-existing 900k auto-compact window (upstream 165000). Upstream has neither — it passes `this.model` and lets the SDK default. Only affects groups with `model = NULL`.)
- **2026-06-27** — Patch 14 applied (`/learn` runtime skill: PR #2843 shipped `/learn` only at `.claude/skills/` (dev level), which isn't mounted into agent containers; copied it to `container/skills/learn/` — the volume-mounted runtime skill path — so it auto-selects for all `skills:"all"` groups on next spawn. No image rebuild, no orchestrator restart; container respawn suffices)
- **2026-06-17** — Patch 13 applied (edge-case fix for patch 12: tolerant `<message>` parse now prefers `</message>` and only strips a TRAILING stray `</parameter>`/`</invoke>` — a quoted tag mid-body no longer truncates the message; ground truth was a confirmation that quoted the tag in backticks)
- **2026-06-17** — Patch 12 applied (turn-stall on rejected response: tolerant `</parameter>`/`</invoke>` closing-tag parsing eliminates the reported trigger; re-prompt cap is now a counter (2) with SPECIFIC feedback naming the bad destination/tag, and gives up loudly instead of idling until the next inbound)
- **2026-06-16** — Patch 11 applied (`<message>` block enqueue fix: accumulate full main-agent turn text and dispatch from it instead of only the SDK `result.result` final text, so a `<message>` block emitted before a trailing tool_use on long tool chains no longer vanishes silently; + loud-fail guard for malformed blocks)
- **2026-06-16** — Patch 10 applied (tool-vis task-session fix: classify suppression on the current turn's `processing_ack` batch, not the global-latest inbound row, so a cron task landing mid-chat-turn no longer silences tool-vis for the reply)
- **2026-06-16** — Patch 09 applied (tool-vis edit coalescing: debounce rolling-bubble edits to ≤1 per 2.5s + finalize-flush so the real reply posts fresh; cuts ~hundreds of tv-edits/turn to a handful, stops burying replies + tripping Telegram flood-control)
- **2026-05-10 22:25** — Patch 06 applied (tool-vis v1.1: bash-prefix + task-suppress + cache-fix bundle, accumulated 2026-05-03 → 2026-05-07)
- **2026-04-30 09:12** — Patch 05 applied (tool-vis v1.0: bash first-line peek + code-fence paths + Agent/Task iteration progress)
- **2026-04-29 20:49** — Patch 04 applied (tool-vis accumulator: edit-in-place per thread, Telegram-style bubble)
- **2026-04-29 20:18** — Patch 03 applied (tool-visibility v0.y: failure detection + result-shape + emoji split)
- **2026-04-29 20:05** — Patch 02 applied (tool-visibility v0.x: domain extraction + path shortening + verb alignment + todo count)
- **2026-04-29 14:14** — Patch 01 applied (telegram maxTextLength wiring) — opened upstream PR #2112 same day

---

## Sibling installations on nanoclaw-host (Andy-owned)

These are **separate projects** installed on the nanoclaw-host filesystem alongside (not inside) `/root/nanoclaw-v2`. They survive nanoclaw-v2 framework updates by virtue of living outside this tree, but they need to exist + be backed up + be recoverable from disaster. Tracked here for inventory + recovery awareness, not as patches.

| Path | Service | Purpose | Backed-up? |
|---|---|---|---|
| `/opt/andy-dashboard/` | `andy-dashboard.service` | Andy infrastructure dashboard, port 3333 | ✅ agents-andy bundle |
| `/root/api-server/` | `andy-api-server.service` | ask-andy HTTP API, port 8643 | ✅ agents-andy bundle |
| `/opt/codex-imagegen-mcp/` | bundled | ChatGPT-Plus image gen wrapper | ✅ agents-andy bundle |
| `/opt/nanoclaw-video/` | (CLI) | Pillow + ffmpeg video renderer (Phase 1-5) | ✅ agents-andy (since 2026-05-10) |
| `/opt/deepgram-cli/` | (CLI) | Deepgram TTS + STT module | ✅ agents-andy (since 2026-05-10) |
| `/etc/systemd/system/nanoclaw-services.service` | `nanoclaw-services` | HTTP API on port 8650 (render-video, tts, stt) | ⚠️ Phase 5 — pending Hermi follow-up |
| `/usr/local/bin/{nanoclaw-video,deepgram-tts,deepgram-stt}` | bash wrappers | first-class CLI in PATH | ✅ agents-andy (since 2026-05-10) |
| `/root/.deepgram-api-key` | secret | Deepgram TTS+STT auth | ✅ agents-andy-secrets bundle |
| `/root/.nanoclaw-services-token` | secret | Bearer token for nanoclaw-services API | ⚠️ Phase 5 — pending Hermi follow-up |
| `/root/scripts/pull-shared-md-to-andy.sh` | crontab `10 * * * *` | Hourly mirror pull canonical (hermi) → Andy group dir | ⚠️ script-only, no data — recoverable from this README |

Bootstrap-from-scratch script for sibling installations: `/root/.hermes/scripts/restore_andy_host_tools.sh` (Hermi-owned, runs apt deps + recreates venvs).

These are documented here so future-Claude knows the **full surface** of what's installed on this host without having to grep across the filesystem.
