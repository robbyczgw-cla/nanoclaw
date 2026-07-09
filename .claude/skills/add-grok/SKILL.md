---
name: add-grok
description: Install the HTTP-only xAI Grok agent provider for NanoClaw. Uses xAI's OpenAI-compatible chat/completions API through OneCLI vault header injection. No CLI, no subprocess, no CLI manifest entry.
---

# Grok agent provider

NanoClaw selects each group's agent backend from `container_configs.provider`.
This skill installs the `xai` provider: host env contribution, container HTTP
provider, setup picker entry, and one import in each provider barrel.

The provider calls `XAI_BASE_URL/chat/completions` directly. Credentials are
vault-only: the container sends `Authorization: Bearer onecli-managed`, and the
OneCLI gateway injects the real xAI credential on outbound requests to
`api.x.ai`.

## Install

Run:

```bash
setup/add-grok.sh
```

This script wires:

- `src/providers/xai.ts`
- `src/providers/xai-registration.test.ts`
- `container/agent-runner/src/providers/xai.ts`
- `container/agent-runner/src/providers/xai-registration.test.ts`
- `setup/providers/xai.ts`
- `setup/providers/xai-registration.test.ts`
- `import './xai.js';` in `src/providers/index.ts`
- `import './xai.js';` in `container/agent-runner/src/providers/index.ts`
- `import './xai.js';` in `setup/providers/index.ts`

There is intentionally no `container/cli-tools.json` entry. Grok is HTTP-only:
no provider CLI is installed and no subprocess is spawned.

## Build

After installing, rebuild the agent image from the target checkout. The install
script does not rebuild images or restart containers.

```bash
pnpm run typecheck
cd container/agent-runner && pnpm run typecheck
./container/build.sh
```

## Authenticate

Create a OneCLI generic secret for xAI with:

- host pattern: `api.x.ai`
- header name: `Authorization`
- value format: `Bearer {value}`

The secret value is the xAI API key. Do not put the key in `.env`,
`container.json`, or chat. Once live OneCLI supports native xAI OAuth, use that
connector instead; the provider should still keep the same managed
Authorization stub inside the container.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider xai --model grok-4.3
ncl groups restart --id <group-id>
```

## Current implementation

Implemented:

- OpenAI-compatible streaming chat completions.
- In-memory continuation while the agent-runner process stays alive.
- Basic MCP tool listing and tool-call execution through stdio MCP servers.
- `reasoning_effort` passthrough when the group has an effort configured.

First-pass limitations:

- No durable server-side history; continuation is lost on runner restart.
- Tool-call handling is basic and capped to avoid loops.
- No xAI-specific OAuth flow in setup until OneCLI exposes it.
