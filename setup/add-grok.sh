#!/usr/bin/env bash
#
# Install the xAI Grok agent provider non-interactively: copy/wire the provider
# files and append the three provider barrels. This provider is HTTP-only:
# no CLI manifest entry, no subprocess, and no container image rebuild here.
# The image rebuild is the caller's job after installation.
#
# Emits exactly one status block on stdout (ADD_GROK); all progress goes to
# stderr. Keep in sync with .claude/skills/add-grok/SKILL.md.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PAYLOAD_FILES=(
  src/providers/xai.ts
  src/providers/xai-registration.test.ts
  container/agent-runner/src/providers/xai.ts
  container/agent-runner/src/providers/xai-registration.test.ts
  setup/providers/xai.ts
  setup/providers/xai-registration.test.ts
  .claude/skills/add-grok/SKILL.md
)
BARRELS=(
  src/providers/index.ts
  container/agent-runner/src/providers/index.ts
  setup/providers/index.ts
)

ALREADY_INSTALLED=true
emit_status() {
  local status=$1 error=${2:-}
  echo "=== NANOCLAW SETUP: ADD_GROK ==="
  echo "STATUS: ${status}"
  echo "ALREADY_INSTALLED: ${ALREADY_INSTALLED}"
  [ -n "$error" ] && echo "ERROR: ${error}"
  echo "=== END ==="
}
log() { echo "[add-grok] $*" >&2; }

need_install() {
  [ ! -f src/providers/xai.ts ] && return 0
  [ ! -f container/agent-runner/src/providers/xai.ts ] && return 0
  [ ! -f setup/providers/xai.ts ] && return 0
  ! grep -q "^import './xai.js';" src/providers/index.ts 2>/dev/null && return 0
  ! grep -q "^import './xai.js';" container/agent-runner/src/providers/index.ts 2>/dev/null && return 0
  ! grep -q "^import './xai.js';" setup/providers/index.ts 2>/dev/null && return 0
  return 1
}

if need_install; then
  ALREADY_INSTALLED=false

  # When run from a branch that already contains the payload, this script only
  # wires barrels. When copied into a target checkout, ADD_GROK_SOURCE may point
  # at a checkout containing the payload files to copy from.
  SOURCE_ROOT="${ADD_GROK_SOURCE:-$PROJECT_ROOT}"
  log "Copying xAI provider payload from ${SOURCE_ROOT}…"
  for f in "${PAYLOAD_FILES[@]}"; do
    if [ "$SOURCE_ROOT" != "$PROJECT_ROOT" ]; then
      mkdir -p "$(dirname "$f")"
      cp "${SOURCE_ROOT}/${f}" "$f" || {
        emit_status failed "source payload missing ${f}"
        exit 1
      }
    elif [ ! -f "$f" ]; then
      emit_status failed "payload missing ${f}; set ADD_GROK_SOURCE to a checkout that contains it"
      exit 1
    fi
  done

  log "Wiring provider barrels…"
  for b in "${BARRELS[@]}"; do
    grep -q "^import './xai.js';" "$b" || printf "import './xai.js';\n" >> "$b"
  done
fi

emit_status ok
