import { describe, expect, it } from 'vitest';

import './index.js';
import { getSetupProvider, listSetupProviders } from './registry.js';

describe('xAI setup provider registration', () => {
  it('is wired through the setup provider barrel', () => {
    expect(listSetupProviders().map((entry) => entry.value)).toContain('xai');
  });

  it('has an install check and auth entry', () => {
    const entry = getSetupProvider('xai');
    expect(entry?.label).toBe('Grok');
    expect(entry?.runInstallCheck).toBeTypeOf('function');
    expect(entry?.runAuth).toBeTypeOf('function');
  });
});
