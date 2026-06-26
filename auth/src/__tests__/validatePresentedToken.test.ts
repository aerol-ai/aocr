import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ProofCache } from '../upstreamAuth/proofCache';
import { parseWrapKeyRing } from '../upstreamAuth/wrap';
import {
  AuthValidationContext,
  buildStaticPatConfig,
  validatePresentedToken,
} from '../serverHelpers';

function validationContext(overrides: Partial<AuthValidationContext> = {}): AuthValidationContext {
  return {
    staticPatConfig: buildStaticPatConfig('pat-one', undefined),
    clusterPatConfig: null,
    validationServiceUrl: undefined,
    keyRing: parseWrapKeyRing(''),
    proofCache: new ProofCache(),
    ...overrides,
  };
}

describe('validatePresentedToken', () => {
  it('returns pat strategy for configured static PAT', async () => {
    const result = await validatePresentedToken('pat-one', null, validationContext());
    assert.equal(result.strategy, 'pat');
  });

  it('throws Invalid PAT when static PAT is configured but token mismatches', async () => {
    await assert.rejects(
      () => validatePresentedToken('wrong', null, validationContext()),
      /Invalid PAT token/,
    );
  });

  it('throws when no validation method is configured', async () => {
    await assert.rejects(
      () => validatePresentedToken('anything', null, validationContext({ staticPatConfig: null })),
      /No validation method configured/,
    );
  });
});
