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

- **2026-04-29 20:49** — Patch 04 applied (tool-vis accumulator: edit-in-place per thread, Telegram-style bubble)
- **2026-04-29 20:18** — Patch 03 applied (tool-visibility v0.y: failure detection + result-shape + emoji split)
- **2026-04-29 20:05** — Patch 02 applied (tool-visibility v0.x: domain extraction + path shortening + verb alignment + todo count)
- **2026-04-29 14:14** — Patch 01 applied (telegram maxTextLength wiring) — opened upstream PR #2112 same day
