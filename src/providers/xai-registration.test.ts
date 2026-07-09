import { describe, expect, it } from 'vitest';

import './index.js';
import { listProviderContainerConfigNames, getProviderContainerConfig } from './provider-container-registry.js';

describe('xAI host provider registration', () => {
  it('is wired through the host provider barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('xai');
  });

  it('contributes only xAI HTTP env and no mounts', () => {
    const config = getProviderContainerConfig('xai');
    expect(config).toBeDefined();

    const contribution = config!({
      sessionDir: '/tmp/session',
      agentGroupId: 'ag_123',
      groupDir: '/tmp/group',
      selectedSkills: [],
      hostEnv: {},
    });

    expect(contribution.mounts).toBeUndefined();
    expect(contribution.env).toEqual({
      XAI_BASE_URL: 'https://api.x.ai/v1',
      XAI_AUTH_TOKEN: 'onecli-managed',
    });
  });
});
