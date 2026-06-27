# Patch 15 — claude.ts local default model + auto-compact window

**File:** `container/agent-runner/src/providers/claude.ts`
**Status:** 🟢 local-only (upstream has neither)
**Applied:** 2026-06-27 (model-fallback line + compact window existed earlier undocumented; formalized here)

## Background

Two local divergences live in `claude.ts`, both absent upstream. They were
carried in the tree before being tracked; this patch documents them and bumps
the model from the now-stale 4.7 to 4.8.

### 1. Hardcoded default-model fallback

- **Upstream** (`merge-base` + `upstream/main`): `model: this.model` — no
  hardcoded fallback. A group with no `model` in `container_configs` passes
  `undefined` to the Claude Agent SDK, which then uses the SDK's own default.
- **Ours**: `model: this.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'`
  — an explicit 3-tier fallback so unconfigured groups land on a **known**
  1M-context model rather than whatever the SDK currently defaults to.

**Bump 4.7 → 4.8:** the literal was `'claude-opus-4-7[1m]'`, set when 4.7 was the
newest 1M-context Opus. Per the Anthropic model catalog there is **no separate
`[1m]` model ID** — `claude-opus-4-8` is **1M-context by default** at the same
price ($5/$25) as 4.7. The `[1m]` suffix was a Claude-Code/agent-SDK convention,
not a catalog ID. Empirically, the explicitly-configured owner groups (Andy,
wowdev) already run plain `claude-opus-4-8` with the 900k compact window below
and clearly have ~1M context (a 900k window can't trigger on a 200k model). So
plain `claude-opus-4-8` gives 1M in our runtime — the suffix isn't needed.

This aligns the 5 unconfigured groups (`model = NULL`: tefy, family, shopify,
cli-with-robby, gildenmeister) with the configured ones. `ANTHROPIC_MODEL` is
not set in our env, so tier 3 is the effective default for those groups.

### 2. Auto-compact window 165000 → 900000

- **Upstream**: `CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000'`.
- **Ours**: `|| '900000'` — 90% of 1M, tuned for the 1M-context default model
  above. Without it the SDK would compact at ~16.5% of a 1M context every turn.

## Why it's safe

- Both are local *defaults* only; an explicit per-group `model` (DB) and the
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var both override them.
- 4.8 ≡ 4.7 in context (1M) and price; strictly newer. No behavior regression.
- The two are coupled by design: the 900k window assumes a 1M default model.
  Keep them in sync — if the default model ever drops below 1M context, lower
  the window too.

## Verify

`grep -q "ANTHROPIC_MODEL ?? 'claude-opus-4-8'" container/agent-runner/src/providers/claude.ts`
and `grep -q "|| '900000'" container/agent-runner/src/providers/claude.ts`
(see `verify.sh`). Typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`.

## Re-apply after upstream reset

Re-apply both edits in `claude.ts`: change `model: this.model` →
`model: this.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8'`, and the
auto-compact default `'165000'` → `'900000'`.
