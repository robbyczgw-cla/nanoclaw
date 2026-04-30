# Patch 02 — Tool-visibility v0.x polish

**Applied:** 2026-04-29 (~20:05 UTC)
**File:** `container/agent-runner/src/hooks/tool-visibility.ts`
**Backup:** `…ts.bak-20260429-2005`
**Apply-script:** `local-patches/02-tool-visibility-v0x.py`
**Diff:** `local-patches/02-tool-visibility-v0x.diff`
**Upstream PR:** none — local-only experiment, deferred until we like it after a week of use.

---

## Why

Default tool-visibility output is functional but harder to scan than Hermes-style:
- Long file paths overflow chat lines on mobile Telegram
- Long URLs dominate previews (full path when only domain matters)
- No vertical alignment between tool calls — each one different width
- TodoWrite shows generic preview (`[object Object],...`) instead of task count

**Inspiration:** Hermes' `get_cute_tool_message` in `/opt/hermes/agent/display.py:837` (on hermi). Hermes pads verbs to 9 chars, extracts domains from URLs, prefixes long paths with `…`, gives per-tool bespoke formatters.

---

## Patch summary

**Additive helper functions** near `truncate()`:

- `domainOf(url)` — strips scheme and path, returns just `github.com`
- `shortPath(p, maxLen=35)` — leading-`…` for long paths, e.g. `…/src/channels/telegram.ts`
- `formatToolLine(emoji, label, desc, count)` — single source of truth for the message format, with `label.padEnd(8)` for vertical alignment

**describeToolInput updates:**
- Read/Write/Edit `file_path` → routes through `shortPath()`
- WebFetch `url` → `domainOf()` instead of full URL
- WebSearch `query` → wrapped in `"…"` quotes for visual distinction
- TodoWrite `todos` → `"N tasks"` summary

**All emit sites route through `formatToolLine()`:** the previous inline `${emoji} ${label}: ${desc}` template is gone — three call sites (`flushBatch`, `preToolUseVisibility`, `postToolUseVisibility`) now use the helper. Behavior is identical, presentation is consistent.

---

## Sample before/after

```
Before:
🌐 fetch: https://github.com/qwibitai/nanoclaw/pull/2116
📖 read: /root/nanoclaw-v2/container/agent-runner/src/hooks/tool-visibility.ts
🖥️ bash: git status
📝 todo: [object Object],[object Object],[object Object]

After:
🌐 fetch    github.com
📖 read     …/agent-runner/src/hooks/tool-visibility.ts
🖥️ bash     git status
📝 todo     3 tasks
```

The verb-alignment (`label.padEnd(8)`) makes scrolling-scan ~3× faster on mobile.

---

## Apply

If a `git pull` resets the file:

```bash
cd /root/nanoclaw-v2

# 1. Backup
cp container/agent-runner/src/hooks/tool-visibility.ts \
   container/agent-runner/src/hooks/tool-visibility.ts.bak-$(date +%Y%m%d-%H%M)

# 2. Re-apply via the patch script
python3 local-patches/02-tool-visibility-v0x.py

# 3. tsc check
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# 4. NO build/restart needed — Bun reads src/ directly. Existing in-flight
#    containers keep old code; new spawns get the new format.
```

Or apply the diff:

```bash
cd /root/nanoclaw-v2
patch -p0 < local-patches/02-tool-visibility-v0x.diff
```

---

## Verify still needed

Run before re-applying — upstream may have adopted similar formatting:

```bash
gh api repos/qwibitai/nanoclaw/contents/container/agent-runner/src/hooks/tool-visibility.ts \
  --jq .content | base64 -d | grep -c 'formatToolLine\|domainOf\|shortPath'
# 0  → upstream still has the basic format → re-apply
# >=1 → upstream adopted similar → diff carefully, may have improved beyond ours
```

---

## Risk + reversal

- **Risk:** Low. Pure presentation change — all tool calls still fire identically.
- **Reverse:** `cp container/agent-runner/src/hooks/tool-visibility.ts.bak-… container/agent-runner/src/hooks/tool-visibility.ts`

---

## Notes

- Stacks below patch 03 (v0.y). Apply 02 before 03 for a clean re-build, since 03's apply-script anchors on v0.x output strings.
- Container-side code: takes effect on next agent-container respawn, not host service restart.
