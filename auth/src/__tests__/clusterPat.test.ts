import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluateClusterPatScope, parseClusterPatEntries } from '../clusterPat';

const CLUSTER_A = 'aabbccdd-eeff-0011-2233-445566778899';
const CLUSTER_B = '11223344-5566-7788-99aa-bbccddeeff00';

describe('parseClusterPatEntries', () => {
  it('returns empty list for undefined or empty input', () => {
    assert.deepEqual(parseClusterPatEntries(undefined), []);
    assert.deepEqual(parseClusterPatEntries(''), []);
    assert.deepEqual(parseClusterPatEntries('   \n  \n'), []);
  });

  it('parses a single entry separated by newline', () => {
    const entries = parseClusterPatEntries(`${CLUSTER_A}=secret-token`);
    assert.deepEqual(entries, [{ clusterId: CLUSTER_A, token: 'secret-token' }]);
  });

  it('parses multiple entries separated by newlines or commas', () => {
    const raw = `${CLUSTER_A}=t1\n${CLUSTER_B}=t2`;
    assert.deepEqual(parseClusterPatEntries(raw), [
      { clusterId: CLUSTER_A, token: 't1' },
      { clusterId: CLUSTER_B, token: 't2' },
    ]);

    const comma = `${CLUSTER_A}=t1,${CLUSTER_B}=t2`;
    assert.deepEqual(parseClusterPatEntries(comma), [
      { clusterId: CLUSTER_A, token: 't1' },
      { clusterId: CLUSTER_B, token: 't2' },
    ]);
  });

  it('skips malformed entries (no = separator)', () => {
    const raw = `garbage\n${CLUSTER_A}=ok\n=missing-cluster-id\nmissing-token=`;
    assert.deepEqual(parseClusterPatEntries(raw), [{ clusterId: CLUSTER_A, token: 'ok' }]);
  });

  it('skips entries whose cluster_id is not a UUID', () => {
    const raw = `not-a-uuid=secret\n${CLUSTER_A}=ok`;
    assert.deepEqual(parseClusterPatEntries(raw), [{ clusterId: CLUSTER_A, token: 'ok' }]);
  });

  it('keeps the last entry when a cluster_id repeats', () => {
    const raw = `${CLUSTER_A}=first\n${CLUSTER_A}=second`;
    assert.deepEqual(parseClusterPatEntries(raw), [{ clusterId: CLUSTER_A, token: 'second' }]);
  });

  it('preserves token characters that look like the separator (only first = splits)', () => {
    const raw = `${CLUSTER_A}=value=with=equals`;
    assert.deepEqual(parseClusterPatEntries(raw), [
      { clusterId: CLUSTER_A, token: 'value=with=equals' },
    ]);
  });
});

describe('evaluateClusterPatScope', () => {
  it('rejects non-repository scope types', () => {
    const decision = evaluateClusterPatScope(CLUSTER_A, 'registry', 'catalog', ['*']);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason || '', /repository scope/);
  });

  it('rejects empty scope name', () => {
    const decision = evaluateClusterPatScope(CLUSTER_A, 'repository', '', ['pull']);
    assert.equal(decision.allowed, false);
  });

  it('allows push+pull inside the own cluster namespace', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      `cluster/${CLUSTER_A}/snap-xyz`,
      ['push', 'pull'],
    );
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.allowedActions, ['push', 'pull']);
  });

  it('allows push+pull on the bare own-cluster namespace prefix', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      `cluster/${CLUSTER_A}`,
      ['push'],
    );
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.allowedActions, ['push']);
  });

  it('rejects pushes into another cluster', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      `cluster/${CLUSTER_B}/snap-xyz`,
      ['push'],
    );
    assert.equal(decision.allowed, false);
    assert.match(decision.reason || '', /outside/);
  });

  it('rejects reads from another cluster', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      `cluster/${CLUSTER_B}/snap-xyz`,
      ['pull'],
    );
    assert.equal(decision.allowed, false);
  });

  it('allows mirror reads but drops push from the requested actions', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      'mirror/aocr/ghcr/aerol-ai/foo',
      ['pull', 'push'],
    );
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.allowedActions, ['pull']);
  });

  it('rejects user-namespace push/pull entirely', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      'acme/my-user-image',
      ['pull'],
    );
    assert.equal(decision.allowed, false);
  });

  it('does not let a cluster-prefix collision sneak through (clusterfoo/...)', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      `cluster${CLUSTER_A}/foo`,
      ['pull'],
    );
    assert.equal(decision.allowed, false);
  });

  it('does not match a different namespace that happens to start with "mirror"', () => {
    const decision = evaluateClusterPatScope(
      CLUSTER_A,
      'repository',
      'mirrorshady/foo',
      ['pull'],
    );
    assert.equal(decision.allowed, false);
  });
});
