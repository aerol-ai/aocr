import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  bindMetricsPool,
  elapsedSecondsSince,
  recordDatabaseSync,
  recordTokenIssuance,
  recordTokenValidation,
  recordUpstreamValidation,
  setConfiguredClusterPatCount,
  setConfiguredPatCount,
} from '../metrics';

describe('auth metrics helpers', () => {
  it('records token validation without throwing', () => {
    const startedAt = process.hrtime.bigint();
    recordTokenValidation('pat', 'success', elapsedSecondsSince(startedAt));
    recordTokenValidation('api', 'error', 0.01);
  });

  it('records upstream validation and database sync', () => {
    recordUpstreamValidation('success', 0.05);
    recordDatabaseSync('error', 0.1);
    recordTokenIssuance('pat', 'success');
    recordTokenIssuance('cluster-pat', 'forbidden');
  });

  it('updates configured PAT gauges without throwing', () => {
    setConfiguredPatCount(2);
    setConfiguredClusterPatCount(1);
  });

  it('bindMetricsPool accepts a pool-shaped object without throwing', () => {
    bindMetricsPool({
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
    } as any);
  });

  it('computes elapsed seconds from hrtime', () => {
    const startedAt = process.hrtime.bigint();
    assert.ok(elapsedSecondsSince(startedAt) >= 0);
  });
});
