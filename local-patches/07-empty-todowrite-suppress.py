#!/usr/bin/env python3
"""Patch 07 — empty-TodoWrite suppress. Idempotent string-replace."""
import sys, re
from pathlib import Path

TARGET = Path("/root/nanoclaw-v2/container/agent-runner/src/hooks/tool-visibility.ts")
ANCHOR_BEFORE = "  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();\n\n  if (BATCH_TOOLS.has(toolName)) {"
ANCHOR_NEW = """  const label = TOOL_LABEL[toolName] ?? toolName.toLowerCase();

  // Patch 07 — suppress empty TodoWrite calls (e.g. clearing stale todos).
  // `📝 todo · 0 tasks` is pure noise; conveys no semantic information.
  if (toolName === 'TodoWrite') {
    const todos = (i.tool_input as { todos?: unknown[] } | undefined)?.todos;
    if (Array.isArray(todos) && todos.length === 0) return { continue: true };
  }

  if (BATCH_TOOLS.has(toolName)) {"""

src = TARGET.read_text()
# Idempotency check — already applied?
if "Patch 07 — suppress empty TodoWrite" in src:
    print("✅ Patch 07 already applied — no-op")
    sys.exit(0)

if ANCHOR_BEFORE not in src:
    print(f"❌ Anchor not found in {TARGET} — manual reapply needed", file=sys.stderr)
    sys.exit(1)

new = src.replace(ANCHOR_BEFORE, ANCHOR_NEW, 1)
TARGET.write_text(new)
print(f"✅ Patch 07 applied to {TARGET}")
