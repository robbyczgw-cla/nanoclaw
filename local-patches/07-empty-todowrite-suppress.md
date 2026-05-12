# Patch 07 — Empty TodoWrite Suppress

**Status:** 🟢 local-only
**File:** `container/agent-runner/src/hooks/tool-visibility.ts`
**Date:** 2026-05-12

## What it does

Suppress the tool-visibility chat-line for `TodoWrite` calls with an empty `todos` array.

Without this patch, an agent calling `TodoWrite({ todos: [] })` (typically to clear a stale post-task list) renders as `📝 todo · 0 tasks` in the chat — a line with zero semantic information that just clutters the user's view.

## When this happens

Common case: an agent finishes a multi-phase task, the system reminds it the todo list looks stale, and the agent clears it with an empty array. The render-line then shows up after the work is already done — pure noise.

## How it works

Adds an early-return inside `preToolUseVisibility` (after `desc/emoji/label` are computed, before `BATCH_TOOLS` / `emit` dispatch) that skips the entire emit pipeline when:
- `toolName === 'TodoWrite'`, AND
- `tool_input.todos` is an array of length 0

`describeToolInput`'s existing TodoWrite branch (`return '${n} task${n === 1 ? '' : 's'}'`) is untouched — the suppress happens at the call-site so the function's pure-describe semantics stay intact.

## Why early-return at the call site (vs. inside `describeToolInput`)

- `describeToolInput` returns a `desc` string; `formatToolLine(emoji, label, desc)` still emits `📝 todo` even if `desc` is empty (label-only line).
- Returning empty from describe would require teaching the caller "if desc is empty AND toolName matches a known no-op suppress list, skip" — more coupling.
- Direct early-return at the call site keeps the suppress logic colocated with the noise source, matching the pattern used by Patch 06's `isTaskSession()` guard inside `emit()`.

## Reapply

```bash
python3 /root/nanoclaw-v2/local-patches/07-empty-todowrite-suppress.py
```

Idempotent — re-runs are no-ops once the anchor comment is present.

## Anchor for `verify.sh`

```bash
grep -q "Patch 07 — suppress empty TodoWrite" container/agent-runner/src/hooks/tool-visibility.ts
```

## Test (manual)

In any agent session:
1. `TodoWrite({ todos: [] })` → expect: no `📝 todo · 0 tasks` line emitted
2. `TodoWrite({ todos: [{ content: 'x', activeForm: 'doing x', status: 'pending' }] })` → expect: `📝 todo · 1 task` emitted as before

Container rebuild required after applying — patch lives in `agent-runner/src/` which is bundled into the container image at build time (not source-mount).
