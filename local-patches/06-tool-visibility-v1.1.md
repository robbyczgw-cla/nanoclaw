# Patch 06 — Tool-visibility v1.1 (bash-prefix + task-suppress + cache-fix bundle)

**Applied:** 2026-05-03 → 2026-05-07 (incremental, finally committed 2026-05-10)
**File:** `container/agent-runner/src/hooks/tool-visibility.ts`
**Backups:** `*.bak-pre-bashprefix-20260503-1056`, `*.bak-pre-task-suppress-20260506-125721`, `*.bak-pre-cache-fix-20260507-181033` (cleaned up at commit time — pre-states recoverable from git history of this commit)
**Apply-script:** none (the `.diff` applies cleanly against patch-05 baseline)
**Diff:** `local-patches/06-tool-visibility-v1.1.diff`
**Upstream PR:** none (deferred — these are operational refinements specific to our scheduled-task + SSH-wrapper patterns)

---

## Why

Three distinct issues in tool-visibility that accumulated over a week:

### A) Bash-prefix eats the preview (2026-05-03)

When agents wrap SSH calls in a key-bundle alias to keep commands readable, the tool-vis bash summarizer was rendering only the assignment, e.g.:

```bash
SSHK="ssh -i /workspace/agent/.ssh/id_ed25519" && $SSHK root@100.114.9.78 "ls /opt"
```

would show as:

```
🖥️ bash `SSHK="ssh -i /workspace/agent/.ssh/id_ed25519"`
```

Useless preview — the actual command was the `$SSHK root@…` part after the `&&`.

### B) Task-session tool-vis spam (2026-05-06)

Scheduled-task sessions (e.g. `Infrastructure monitoring — STRICT mode`) are designed to run silent on success. But tool-vis fired tool-call previews into the user's chat anyway — **orphan messages with no context**:

```
🤖 Andy
🖥️ bash `df -h /`
```

…and nothing after it (because the task ran, found nothing wrong, and stayed silent per its instructions). Pure noise.

### C) Per-process `isTaskSession` cache locked the value forever (2026-05-07)

Initial fix for (B) cached `isTaskSession()` result per-container-lifetime. But containers stay up for hours, and a single container handles BOTH chat messages AND scheduled-task wake-ups across that lifetime. First call (e.g. an interactive chat message) cached `false`. Every subsequent task-cron-fire was misclassified as a non-task session → tool-vis spam re-appeared two days after the "fix".

---

## Patch summary

**A) `summarizeBash` — skip pure-assignment segments + treat `$VAR` as ssh-like:**

```ts
const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
const isPureAssignment = (s: string) =>
  /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*)+$/.test(s);
let first = segments[0] ?? '';
for (const seg of segments) {
  if (isPureAssignment(seg)) continue;
  first = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  break;
}
// …
const isSshLike = bin === 'ssh' || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(words[0] ?? '');
if (isSshLike) {
```

Gives meaningful previews for the SSH-bundle pattern.

**B) `emit` — early-return on task sessions:**

```ts
function emit(text: string): void {
  if (isTaskSession()) return;
  try { … }
}
```

Tool-vis is opt-in for chat sessions only. Task sessions get full silence by default; if a task explicitly wants visibility, the cron prompt can flip an override (future enhancement, not in this patch).

**C) `isTaskSession` — re-query every call, no cache:**

```ts
function isTaskSession(): boolean {
  try {
    const db = getInboundDb();
    const row = db.prepare(
      "SELECT kind FROM messages_in ORDER BY seq DESC LIMIT 1"
    ).get() as { kind?: string } | undefined;
    return row?.kind === 'task';
  } catch { return false; }
}
```

Microsecond cost per call (sqlite point query on indexed column), correct behavior across container-lifetime boundaries.

---

## Verification

After apply, all three behaviors should hold:

```bash
# A) bash preview — should show `ssh root@host "..."` not the var assignment
grep -A 2 'isPureAssignment' container/agent-runner/src/hooks/tool-visibility.ts

# B) emit guards on task session
grep 'if (isTaskSession()) return' container/agent-runner/src/hooks/tool-visibility.ts

# C) isTaskSession re-queries (no module-level let cache var)
grep -A 5 'function isTaskSession' container/agent-runner/src/hooks/tool-visibility.ts
```

`local-patches/verify.sh` includes patch 06 in its checklist (search anchor: `isTaskSession`).

---

## Re-apply after upstream pull

```bash
cd /root/nanoclaw-v2
patch -p0 < local-patches/06-tool-visibility-v1.1.diff
```

If `patch` complains about context drift, the anchor strings (`segments.split`, `isSshLike`, `if (isTaskSession()) return`) are unique enough to manually merge. The patch only touches `container/agent-runner/src/hooks/tool-visibility.ts`.
