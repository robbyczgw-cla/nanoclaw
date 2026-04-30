# Patch 03 — Tool-visibility v0.y (failure detection + result-shape + emoji split)

**Applied:** 2026-04-29 (~20:18 UTC)
**File:** `container/agent-runner/src/hooks/tool-visibility.ts`
**Backup:** `…ts.bak-20260429-2018-vy`
**Apply-script:** `local-patches/03-tool-visibility-v0y.py`
**Diff:** `local-patches/03-tool-visibility-v0y.diff`
**Upstream PR:** none — local-only experiment, deferred. Reconsider after observing for a week.
**Depends on:** Patch 02 (v0.x) must be applied first.

---

## Why

v0.x cleaned up the *call* presentation. v0.y addresses three remaining gaps:

1. **Silent failures** — the post-hook only emitted a "done" marker for slow Bash. Failed tool calls (anything non-Bash, or fast-fail Bash) showed only the pre-hook line — visually indistinguishable from success. We hit this several times where a tool errored and only logs revealed it.
2. **Missing result-shape** — even on success, no hint about *what* came back. Did the Read return 5 lines or 5000? Did the Bash output anything? Hermes shows compact hints (`47 matches`, `1234 lines`).
3. **Emoji collision** — Edit and Write both used `✏️`, indistinguishable in chat. Edit modifies, Write creates — they should look different.

**Inspiration:** Same Hermes display.py reference as v0.x; specifically `_detect_tool_failure` and the per-tool result-shape extraction inside `get_cute_tool_message`.

---

## Patch summary

**TOOL_EMOJI / TOOL_LABEL / BATCH_TOOLS**: add `MultiEdit` (Bun SDK alias of Edit when batched) and split Write emoji to `✍️` (writing hand). Edit stays `✏️` (pencil-modify).

**New helpers** added after `formatToolLine()`:

- `extractResponseText(toolResponse)` — defensively pulls a string out of unknown-shape responses (`string` | `{output}` | `{text}` | `{content}` | `{stdout}`). Returns null when nothing string-y is found.
- `resultShape(toolName, toolResponse)` — per-tool compact result hint. Currently:
  - `Read` → `${lines} lines`
  - `Bash` → `${nonEmptyLines} lines` (only if ≥5 non-empty lines, to avoid trivial spam)
  - `WebFetch` → `${kb}KB` (only if ≥1 KB)
  - returns null otherwise (caller decides whether to emit)
- `detectFailureFromResponse(toolName, toolResponse)` — heuristic failure detection. Checks structured fields first (`is_error`, `success: false`, `error: string`), then falls back to conservative regex patterns on the response text. Returns the failure message (≤80 chars) or null.

**`postToolUseVisibility` rewritten** to:
1. Inspect `hook_event_name` — if `'PostToolUseFailure'`, the SDK already raised an error. Format as `❌ {label} {desc}  ✗ {error}`.
2. Otherwise check `detectFailureFromResponse()` — some tools report errors in the normal response payload. Same `❌` formatting.
3. Otherwise success path — for slow Bash, append `resultShape()` hint to the existing `done in Xs` message.

**Other tools** still rely on the pre-hook for visibility on success. v0.y deliberately *doesn't* emit a per-call success-line for Read/WebFetch/etc. — would be too chatty. Result-shape only fires for slow Bash where we already emit anyway.

---

## Sample before/after

```
Before (v0.x):
🌐 fetch    github.com
🖥️ bash     rm /etc/secret
🖥️ bash     done in 0.0s          ← looks like success even when permission denied!
📖 read     …/big-config.json

After (v0.y):
🌐 fetch    github.com
❌ bash     rm /etc/secret  ✗ Permission denied
🖥️ bash     done in 5.2s  287 lines
📖 read     …/big-config.json     ← same as v0.x; no spammy success line
✍️ write    …/output.md           ← Write now visually distinct from Edit
```

---

## Apply

If a `git pull` resets the file (apply 02 first, then 03):

```bash
cd /root/nanoclaw-v2

# 1. Backup
cp container/agent-runner/src/hooks/tool-visibility.ts \
   container/agent-runner/src/hooks/tool-visibility.ts.bak-$(date +%Y%m%d-%H%M)

# 2. Apply 02 (v0.x) FIRST — 03 anchors on v0.x output strings
python3 local-patches/02-tool-visibility-v0x.py

# 3. Apply 03 (v0.y)
python3 local-patches/03-tool-visibility-v0y.py

# 4. tsc check
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# 5. No build/restart needed — Bun reads src/ directly. Container respawn picks up.
```

Or use diffs:

```bash
cd /root/nanoclaw-v2
patch -p0 < local-patches/02-tool-visibility-v0x.diff
patch -p0 < local-patches/03-tool-visibility-v0y.diff
```

---

## Verify still needed

```bash
gh api repos/qwibitai/nanoclaw/contents/container/agent-runner/src/hooks/tool-visibility.ts \
  --jq .content | base64 -d | grep -c 'detectFailureFromResponse\|resultShape\|extractResponseText'
# 0  → upstream still has no failure-detection → re-apply
# >=1 → upstream adopted similar → diff carefully
```

---

## Risk + reversal

- **Risk:** Low. The failure-detection branches return early — they only add a new emission, never block existing flows. The result-shape extraction is wrapped in null-checks; unknown response shapes silently degrade to no-hint.
- **Heuristic false-positives:** `detectFailureFromResponse` regex patterns are conservative (`Permission denied`, `command not found`, `Traceback`, etc.) but could in theory match inside successful output that quotes those strings. If that becomes annoying, tighten the patterns (e.g. anchor at line start) or remove the regex fallback entirely and rely only on structured `is_error` fields.
- **Reverse:** revert backup file or apply diffs in reverse (`patch -R`).

---

## Notes

- Container-side: takes effect on next agent-container respawn.
- v0.y depends on the SDK's `PostToolUseFailure` event being fired separately from `PostToolUse`. The hook is registered for both events in `container/agent-runner/src/providers/claude.ts` line 289. If upstream restructures hooks, this assumption may break — re-verify before next major SDK upgrade.
- Future work (v0.z, deferred): per-tool result-shape for Read/Grep/Edit; iteration progress for Agent/Task; channel-aware HTML formatting for Telegram.
