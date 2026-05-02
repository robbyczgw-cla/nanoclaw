# Patch 05 — Tool-visibility v1.0 (bash preview + code-fence + iteration progress)

**Applied:** 2026-04-30 (~09:12 UTC)
**File:** `container/agent-runner/src/hooks/tool-visibility.ts`
**Backup:** `…ts.bak-20260430-0912-v1`
**Apply-script:** `local-patches/05-tool-visibility-v1.py`
**Diff:** `local-patches/05-tool-visibility-v1.diff` (+43 / -9)
**Upstream PR:** none — local-only experiment.
**Depends on:** Patches 02 (v0.x), 03 (v0.y), 04 (accumulator) must be applied first.

---

## Why

After v0.x/y/z stabilized, three remaining UX gaps:

1. **Bash post-completion silence about content** — slow-bash showed `done in 5s 287 lines` but no hint about WHAT came back. A failed-but-non-erroring command (e.g. successful curl returning 404 body) looked identical to a meaningful run.
2. **Mobile readability of paths/cmds** — verb-aligned text was scannable but paths/commands rendered as plain text. Mobile Telegram supports inline-code (backticks) → monospace + color-distinct, much faster scan.
3. **Long-running Agent/Task silent gap** — between pre-tool emit and post-tool emit, multi-minute sub-agent calls left the user staring at a static "🤖 task: …" line. Hermes already does this ("⏳ Still working… iteration 16/90"); nanoclaw didn't.

---

## Patch summary

**v1.0a — Bash output first-line preview:**
- `resultShape()` for Bash now extracts the first non-empty line (truncated to 60 chars) as a peek. Format: `done in 5.2s  287 lines  → \`On branch main\``. For shorter output (<5 lines), shows just the peek without line count.

**v1.0b — Code-fence path/cmd values:**
- `describeToolInput()` wraps the returned desc in backticks for `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`. Telegram MarkdownV1 renders backticks as monospace + color-distinct → mobile-readable.
- TodoWrite count + Task description stay plain (not path-like).

**v1.0c — Agent/Task progress emitter:**
- New constants: `PROGRESS_FIRST_DELAY_MS = 30000`, `PROGRESS_INTERVAL_MS = 30000`.
- New registry: `progressTimers: Record<string, ReturnType<typeof setInterval>>` keyed by tool_use_id.
- Pre-hook for Agent/Task: `setInterval(tick, 30s)` started after `setTimeout(tick, 30s)` for first delay. Each tick emits `⏳ {label}  still working — Xm Ys elapsed` (formatted seconds → minutes when ≥60s).
- Post-hook: `clearInterval(progressTimers[id])` + delete entry. No-op if call returns before 30s threshold.

---

## Sample before/after

```
BEFORE (v0.z):
🖥️ bash     git status
🖥️ bash     done in 5.2s  287 lines

📖 read     /workspace/agent/long/path/to/file.ts

🤖 task     Long research task...
[silence for 90 seconds]
🤖 task     done in 95.4s

AFTER (v1.0):
🖥️ bash     `git status`
🖥️ bash     done in 5.2s  287 lines  → `On branch main`

📖 read     `/workspace/agent/long/path/to/file.ts`        ← rendered as monospace

🤖 task     Long research task...
⏳ task     still working — 30s elapsed
⏳ task     still working — 1m 0s elapsed
⏳ task     still working — 1m 30s elapsed
🤖 task     done in 95.4s
```

(Code-fence rendering is mobile-Telegram-specific via MarkdownV1; falls back gracefully on channels without inline-code support.)

---

## Apply

After a `git pull` or `pnpm install`, re-apply patches 02→03→04→05 in order:

```bash
cd /root/nanoclaw-v2

# Backup
TS=$(date +%Y%m%d-%H%M)
cp container/agent-runner/src/hooks/tool-visibility.ts \
   container/agent-runner/src/hooks/tool-visibility.ts.bak-$TS-v1

# Apply in order — each script anchors on prior version's strings
python3 local-patches/02-tool-visibility-v0x.py
python3 local-patches/03-tool-visibility-v0y.py
python3 local-patches/04-tool-vis-accumulator.py   # hook + bridge
python3 local-patches/05-tool-visibility-v1.py

# Verify
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# Container respawn (Bun reads source — no host build/restart needed for v1.0)
docker restart <andy-container-id>
```

Or via diff:

```bash
patch -p0 < local-patches/05-tool-visibility-v1.diff
```

---

## Verify still needed

```bash
gh api repos/qwibitai/nanoclaw/contents/container/agent-runner/src/hooks/tool-visibility.ts \
  --jq .content | base64 -d | grep -c 'progressTimers\|PROGRESS_INTERVAL_MS'
# 0  → upstream still has no progress emitter → re-apply
# >=1 → upstream adopted similar → diff carefully
```

---

## Risk + reversal

- **Risk:** Low. v1.0a's first-line peek is wrapped in null-checks — gracefully degrades if `tool_response` is unparseable. v1.0b only changes the desc returned by `describeToolInput()`, no flow change. v1.0c uses isolated timers keyed on tool_use_id — leaks would only be possible if the post-hook never fires (unlikely; hook is registered for both `PostToolUse` and `PostToolUseFailure`).
- **Backtick conflicts:** if `describeToolInput()` returns a value that itself contains backticks, the rendered Telegram message could break MarkdownV1 escape. Defensive option (deferred): `text.replace(/`/g, "'")` before wrapping. Hasn't shown up in practice yet — paths/URLs/queries don't normally contain backticks.
- **Reverse:** revert backup file or apply diff in reverse (`patch -R`).

---

## Edge cases NOT handled (future work)

- **Code-fence in non-Telegram channels** — Slack uses different code-fence syntax (triple-backticks for blocks, single-backticks for inline like Telegram, but with possibly different rendering quirks). Discord renders MarkdownV1 backticks correctly. Other adapters: unknown. Currently we emit raw backticks; channel-aware sanitization would be a follow-up.
- **Progress emit during accumulator-active turn** — the progress messages fire through the same `emit()` → outbound.db → bridge accumulator path. So they get appended to the same accumulating bubble. That's correct behavior for Telegram (accumulator wins), but may look odd in non-edit channels (each progress = new message). Acceptable for now.
- **Bash peek for binary output** — if a bash command outputs binary (unlikely but possible: `cat /bin/ls`), the first-line peek will contain garbage. Mitigation: the slice(0, 60) cap limits damage. No regression vs prior behavior.

---

## Notes

- v1.0c progress emit is INSIDE the accumulator (since emit() sets `_toolVis: true`). On Telegram, the bubble grows as progress lines append. On non-edit channels, each progress is a separate message — could be noisy for long sub-agent runs. Acceptable trade-off; non-Telegram users are rare.
- Iteration progress fires only for `Agent` and `Task` tool names — Read/Write/Edit/Bash/etc. are skipped (their pre-hook is enough since they're typically <30s). If we ever have a tool that takes >30s but isn't Agent/Task, add it to the trigger condition manually.
