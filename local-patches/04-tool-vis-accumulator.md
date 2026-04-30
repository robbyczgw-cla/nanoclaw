# Patch 04 — Tool-visibility accumulator (Telegram-style edit-in-place)

**Applied:** 2026-04-29 (~20:49 UTC)
**Files:**
- `container/agent-runner/src/hooks/tool-visibility.ts`
- `src/channels/chat-sdk-bridge.ts`
**Backups:** `…ts.bak-20260429-2049-vz` (both files)
**Apply-script:** `local-patches/04-tool-vis-accumulator.py`
**Diffs:**
- `local-patches/04-tool-vis-accumulator-hook.diff` (container side, 14 lines)
- `local-patches/04-tool-vis-accumulator-bridge.diff` (host side, 120 lines)
**Upstream PR:** none — local-only experiment. If we like it after a week, consider upstream.
**Depends on:** Patches 02 (v0.x) and 03 (v0.y) must be applied first.

---

## Why

Hermes' Telegram chat shows a single accumulating bubble for tool calls during a turn — `terminal:` lines stack inside one message that's edited as new calls fire. nanoclaw was emitting one Telegram message per tool call, generating 6-10 separate notifications for a multi-step turn. Robby flagged it as much worse mobile UX than Hermi's pattern.

Reference: see Telegram screenshot from 2026-04-29 22:43 — Hermi's `Robbyhermi` bubble shows 6 stacked `terminal:` lines + 2 `fact_store:` lines, all in one bubble.

---

## Patch summary

**Container side (`tool-visibility.ts`)** — minimal change:
- `emit()` now adds `_toolVis: true` to the outbound content JSON. Existing `text` field unchanged.

**Host side (`chat-sdk-bridge.ts`)** — adds an in-memory accumulator:
- New `ToolVisAccumulator` interface: `{ messageId, lines[], combinedLength }`
- `Map<string, ToolVisAccumulator>` keyed by `${tid}:tool-vis`, scoped to the bridge closure
- `deliverToolVisAccumulator(tid, lineText, accumKey)` — first emit sends fresh and stores msg_id; subsequent emits call `adapter.editMessage(...)` with the combined text
- `deliver()` intercepts `_toolVis === true` and routes through the accumulator helper
- Any non-tool-vis message to the same thread (the agent's actual answer) flushes the accumulator (`Map.delete`) so the answer renders as a fresh bubble

---

## Behavior

```
BEFORE patch 04:                          AFTER patch 04:
═══════════════════                       ════════════════════════════════════════
[Bubble 1] 🖥️ bash    sleep 4              [Bubble 1]
[Bubble 2] 🖥️ bash    done in 4.0s 25 ln    🖥️ bash     sleep 4
[Bubble 3] ❌ bash    cat /no  ✗ ENOENT     🖥️ bash     done in 4.0s  25 lines
[Bubble 4] ✍️ write   …/file.md             ❌ bash     cat /no  ✗ ENOENT
[Bubble 5] ✏️ edit    …/file.md             ✍️ write    …/file.md
[Bubble 6] 🌐 fetch   github.com            ✏️ edit     …/file.md
[Bubble 7] 📝 todo    6 tasks               🌐 fetch    github.com
                                            📝 todo     6 tasks
[Bubble 8] {agent's actual answer}
                                          [Bubble 2] {agent's actual answer}
```

Same content, dramatically less notification spam.

---

## Apply

After a `git pull` or `pnpm install`, run patches in order:

```bash
cd /root/nanoclaw-v2

# 1. Backup
TS=$(date +%Y%m%d-%H%M)
cp container/agent-runner/src/hooks/tool-visibility.ts \
   container/agent-runner/src/hooks/tool-visibility.ts.bak-$TS-vz
cp src/channels/chat-sdk-bridge.ts \
   src/channels/chat-sdk-bridge.ts.bak-$TS-vz

# 2. Apply 02 (v0.x), 03 (v0.y), 04 (accumulator) in order
python3 local-patches/02-tool-visibility-v0x.py
python3 local-patches/03-tool-visibility-v0y.py
python3 local-patches/04-tool-vis-accumulator.py

# 3. Type-check
pnpm exec tsc --noEmit                                          # host
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit  # container

# 4. Build host (the bridge change is host-side, needs dist/ rebuild)
pnpm build

# 5a. Container respawn (picks up _toolVis flag in tool-visibility.ts)
docker restart <andy-container-id>   # or wait for natural respawn

# 5b. Host service restart (picks up new bridge code in dist/)
systemctl restart nanoclaw-v2-*.service   # ⚠️ kills ALL containers
```

Or apply diffs:

```bash
patch -p0 < local-patches/04-tool-vis-accumulator-hook.diff
patch -p0 < local-patches/04-tool-vis-accumulator-bridge.diff
```

---

## Rollout staging

This patch has two halves with independent failure modes:

| Container has flag | Host has accumulator | Behavior |
|---|---|---|
| ❌ | ❌ | Original (1 msg per tool call) |
| ✅ | ❌ | Container emits flag, host ignores → original behavior (safe) |
| ❌ | ✅ | No flag in content → host accumulator never triggers (safe) |
| ✅ | ✅ | Full accumulator behavior |

→ **Apply order doesn't matter for correctness.** Worst case is "no improvement" until both sides are live; never breakage.

---

## Verify still needed

```bash
gh api repos/qwibitai/nanoclaw/contents/src/channels/chat-sdk-bridge.ts \
  --jq .content | base64 -d | grep -c 'toolVisAccumulators\|deliverToolVisAccumulator'
# 0  → upstream still has no accumulator → re-apply
# >=1 → upstream adopted similar → diff carefully
```

---

## Risk + reversal

- **Risk:** Moderate. New code path for any `_toolVis: true` message; old path for everything else. Bridge state is in-memory and short-lived (cleared on each non-tool-vis message). Worst-case bug: edit fails repeatedly → falls back to fresh sends, equivalent to pre-patch behavior.
- **Telegram rate-limit:** ~30 edits/min/chat. If a turn fires 30+ tool calls in 60s, edits will start hitting 429s. Current code catches the error and falls back to a fresh send (and resets the accumulator). Future polish (v0.z+1): add a debouncer at the hook side so multiple rapid emits collapse into a single edit per ~250ms window.
- **Reverse:** revert backup files; `pnpm build`; restart service.

---

## Edge cases handled

- **Length overflow** — if `combinedLength + new lineText` would exceed `config.maxTextLength`, we close the current accumulator and start a fresh one. Avoids needing to track edits across split chunks.
- **Edit fails** — caught, logged via `log.warn`, falls back to fresh send + restart accumulator.
- **Adapter without editMessage support** — same as edit-fails path; accumulator silently degrades to per-call sends.
- **Cross-thread accumulators** — keyed by `${tid}:tool-vis`, so a tool call in DM doesn't pollute a group-chat accumulator.
- **Non-tool-vis interrupts** — the agent's actual response triggers `Map.delete(accumKey)`, ensuring the answer renders as its own bubble.

---

## Edge cases NOT handled (future work)

- **Long-running turns spanning maxTextLength** — when accumulator hits the cap and rolls to a new bubble, the previous bubble keeps its old contents. Some readers may prefer a footer marker (`(continued in next message)`). Skipped for v0.z to keep diff small.
- **Concurrent agent emits + user message** — if user sends a chat message while the agent is mid-turn, both go through `deliver()`. The user message arrives via inbound (different code path), so doesn't disturb the accumulator. But a system-injected message could. Low risk — system messages are rare.
- **Container/host version skew** — if the host bridge is on a newer version than the container hook (or vice versa), behavior degrades gracefully (see "Rollout staging" table). No special handling needed.

---

## Notes

- Container-side change applies on next agent-container respawn (Bun reads source).
- Host-side change applies after `pnpm build` + `systemctl restart nanoclaw-v2-*.service`. The restart kills all running agent containers — schedule when no critical work is in flight.
- Accumulator state is process-local (in the host's bridge closure). Lost on host restart; created fresh on next message. No persistence needed.
