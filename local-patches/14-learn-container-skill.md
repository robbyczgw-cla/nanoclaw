# Patch 14 — `/learn` available as a runtime skill in agent containers

**File:** `container/skills/learn/SKILL.md` (copied from `.claude/skills/learn/SKILL.md`)
**Status:** 🟢 local-only (upstream ships `/learn` only at the repo/dev level)
**Applied:** 2026-06-27

## Problem

PR #2843 (commits `ce55af1` / `520ec44`, merged into v2.1.21) added the `/learn`
skill — but only at **`.claude/skills/learn/`** (the repo/dev level, i.e. for
Claude Code running on the host). Agent **containers** never see it:
`container-runner.ts` mounts only `container/skills/` → `/app/skills` (read-only);
`.claude/skills/` is **not** mounted into containers. So `/learn` was absent from
every agent's skill list and not invocable by agents (e.g. Andy).

## How agent skills are discovered (verified)

1. `container/skills/` is volume-mounted **read-only** at `/app/skills`
   (`container-runner.ts` ~L364-366) — **not baked into the image**.
2. At **every spawn**, `syncSkillSymlinks()` (`container-runner.ts` ~L388) creates
   symlinks in the group's `.claude-shared/skills/` → `/app/skills/<name>`, for
   each skill in `selectedSkillNames(containerConfig)`.
3. `.claude-shared` is mounted at `/home/node/.claude` (rw), so the symlinks land
   at `/home/node/.claude/skills/<name>` — which the Claude Agent SDK reads as a
   **user** skill (`settingSources: ['project','user','local']` in `claude.ts`).
4. `selectedSkillNames` with `skills: 'all'` **recomputes from the
   `container/skills/` listing** — so a newly-added skill dir auto-appears for any
   `'all'` group on next spawn (comment at `container-runner.ts` ~L428).

All 8 groups are `skills: "all"` (`container_configs`), so **adding the dir is
sufficient** — no DB/`container.json` edit, no image rebuild, no orchestrator
restart. A **container respawn** picks it up.

## Change

`cp -a .claude/skills/learn container/skills/learn` (single `SKILL.md`, matching
the one-file convention of the other container skills).

## Why it's safe

- Pure additive: a new read-only skill dir under an already-mounted path.
- No code, no deps, no image change. Reversible by `rm -rf container/skills/learn`.
- Other `'all'` groups also gain `/learn` on their next spawn (intended).

## Verify

`grep -q '^name: learn' container/skills/learn/SKILL.md` (see `verify.sh`).
After respawn, the host-side symlink confirms selection:
`ls -l data/v2-sessions/<group>/.claude-shared/skills/learn` →
`-> /app/skills/learn`. Definitive: an agent lists `/learn` in its skills.

## Re-apply after upstream reset

If upstream later ships `learn` in `container/skills/` too, this becomes a no-op
(dedupe to the upstream copy). Until then:
`cp -a .claude/skills/learn container/skills/learn`
