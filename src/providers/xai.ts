/**
 * Host-side container config for the HTTP-only xAI provider.
 *
 * The real xAI credential is vault-only. The container sends an
 * Authorization header with a managed stub; OneCLI rewrites it on the wire for
 * api.x.ai using the operator's vault credential.
 */
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('xai', () => ({
  env: {
    XAI_BASE_URL: 'https://api.x.ai/v1',
    XAI_AUTH_TOKEN: 'onecli-managed',
  },
}));
