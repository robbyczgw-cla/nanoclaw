import fs from 'fs';
import path from 'path';

import { registerSetupProvider } from './registry.js';

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function hasImport(file: string, importLine: string): boolean {
  try {
    return fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf-8').includes(importLine);
  } catch {
    return false;
  }
}

export async function runXaiInstallCheck(): Promise<void> {
  const requiredFiles = [
    'src/providers/xai.ts',
    'src/providers/xai-registration.test.ts',
    'container/agent-runner/src/providers/xai.ts',
    'container/agent-runner/src/providers/xai-registration.test.ts',
    'setup/providers/xai.ts',
    'setup/providers/xai-registration.test.ts',
    '.claude/skills/add-grok/SKILL.md',
    'setup/add-grok.sh',
  ];
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(PROJECT_ROOT, file)));
  if (missing.length > 0) {
    throw new Error(`xAI provider install incomplete; missing: ${missing.join(', ')}`);
  }

  const missingImports = [
    ['src/providers/index.ts', "import './xai.js';"],
    ['container/agent-runner/src/providers/index.ts', "import './xai.js';"],
    ['setup/providers/index.ts', "import './xai.js';"],
  ].filter(([file, line]) => !hasImport(file, line));
  if (missingImports.length > 0) {
    throw new Error(
      `xAI provider install incomplete; missing barrel imports: ${missingImports
        .map(([file, line]) => `${file} (${line})`)
        .join(', ')}`,
    );
  }
}

async function runXaiAuth(): Promise<void> {
  await runXaiInstallCheck();
  console.log('xAI provider installed.');
  console.log('Store the xAI API key in OneCLI as a generic api.x.ai Authorization header secret.');
  console.log('The container sends Authorization: Bearer onecli-managed; OneCLI injects the real value on the wire.');
}

registerSetupProvider({
  value: 'xai',
  label: 'Grok',
  hint: 'xAI — HTTP-only via OneCLI vault',
  runAuth: runXaiAuth,
  runInstallCheck: runXaiInstallCheck,
});
