# Patch 19 — 📚 icon for the Skill tool in tool-vis

**File:** container/agent-runner/src/hooks/tool-visibility.ts (mounted RO into containers — Bun runs the TS live, no image rebuild; takes effect on next container spawn / orchestrator restart).
**Applied:** 2026-06-28

When the agent invokes a skill, the tool-vis line now shows **📚** + label `skill` + the skill name (e.g. `📚 skill   `almanach26``) instead of the generic 🔧, so skill usage is visually distinct. Three additions: `Skill: '📚'` in TOOL_EMOJI, `Skill: 'skill'` in TOOL_LABEL, and a describeToolInput case returning `input.skill`. Backup: tool-visibility.ts.bak-skillicon-*.
