import { describe, expect, it } from 'bun:test';

import './index.js';
import { createProvider } from './factory.js';
import { listProviderNames } from './provider-registry.js';

describe('xAI container provider registration', () => {
  it('is wired through the container provider barrel', () => {
    expect(listProviderNames()).toContain('xai');
  });

  it('creates an HTTP provider instance', () => {
    const provider = createProvider('xai', { env: { XAI_AUTH_TOKEN: 'onecli-managed' } });
    expect(provider.supportsNativeSlashCommands).toBe(false);
    expect(provider.usesMemoryScaffold).toBe(true);
  });
});
