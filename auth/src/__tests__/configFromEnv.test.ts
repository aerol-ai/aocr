import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { configFromEnv } from '../createApp';

describe('configFromEnv', () => {
  it('maps environment variables into auth service config', () => {
    const config = configFromEnv({
      VALIDATION_SERVICE_URL: 'https://auth.example.com',
      AUTH_PAT_TOKEN: 'pat',
      AUTH_PAT_TOKENS: 'pat2',
      AUTH_CLUSTER_PAT_TOKENS: 'cluster=a',
      JWT_PRIVATE_KEY: 'key',
      AUTH_ISSUER: 'issuer',
      REGISTRY_SERVICE: 'registry',
      UPSTREAM_AUTH_WRAP_KEYS: 'current:abc',
    } as NodeJS.ProcessEnv);

    assert.equal(config.validationServiceUrl, 'https://auth.example.com');
    assert.equal(config.authPatToken, 'pat');
    assert.equal(config.jwtPrivateKey, 'key');
    assert.equal(config.issuer, 'issuer');
    assert.equal(config.defaultRegistryService, 'registry');
    assert.equal(config.upstreamAuthWrapKeys, 'current:abc');
  });
});
