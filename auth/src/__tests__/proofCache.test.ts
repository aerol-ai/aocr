import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ProofCache } from '../upstreamAuth/proofCache';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

describe('ProofCache.record + get', () => {
  it('returns null on miss', () => {
    const cache = new ProofCache();
    assert.equal(cache.get(ID_A, 'library/redis'), null);
  });

  it('returns the recorded proof on hit', () => {
    const cache = new ProofCache();
    cache.record(ID_A, 'library/redis', 'upstream-bearer-xyz');
    const result = cache.get(ID_A, 'library/redis');
    assert.ok(result);
    assert.equal(result.upstreamBearer, 'upstream-bearer-xyz');
    assert.ok(result.scopedRepos.has('library/redis'));
  });

  it('returns null when proof exists but does not cover the requested repo', () => {
    const cache = new ProofCache();
    cache.record(ID_A, 'library/redis', 'bearer');
    assert.equal(cache.get(ID_A, 'library/postgres'), null);
  });

  it('widens scope when same identity records additional repos', () => {
    const cache = new ProofCache();
    cache.record(ID_A, 'library/redis', 'bearer');
    cache.record(ID_A, 'library/postgres', 'bearer2');
    const hitRedis = cache.get(ID_A, 'library/redis');
    const hitPg = cache.get(ID_A, 'library/postgres');
    assert.ok(hitRedis);
    assert.ok(hitPg);
    // Second record's bearer wins; both repos share it.
    assert.equal(hitRedis.upstreamBearer, 'bearer2');
    assert.equal(hitPg.upstreamBearer, 'bearer2');
  });

  it('recordScope widens without rewriting the bearer or resetting TTL', () => {
    let now = 1_000_000;
    const cache = new ProofCache({ ttlMs: 5000, now: () => now });
    cache.record(ID_A, 'library/redis', 'bearer');
    const originalExpiry = cache.get(ID_A, 'library/redis')!.expiresAt.getTime();
    now += 1000;
    cache.recordScope(ID_A, 'library/nginx');
    const hit = cache.get(ID_A, 'library/nginx');
    assert.ok(hit);
    assert.equal(hit.upstreamBearer, 'bearer');
    assert.equal(hit.expiresAt.getTime(), originalExpiry);
  });
});

describe('ProofCache TTL', () => {
  it('expires entries after ttlMs', () => {
    let now = 1_000_000;
    const cache = new ProofCache({ ttlMs: 1000, now: () => now });
    cache.record(ID_A, 'repo', 'bearer');
    assert.ok(cache.get(ID_A, 'repo'));
    now += 999;
    assert.ok(cache.get(ID_A, 'repo'));
    now += 1;
    assert.equal(cache.get(ID_A, 'repo'), null);
    assert.equal(cache.size(), 0);
  });

  it('resets expiry when the same identity is re-recorded', () => {
    let now = 1_000_000;
    const cache = new ProofCache({ ttlMs: 1000, now: () => now });
    cache.record(ID_A, 'repo', 'bearer');
    now += 800;
    cache.record(ID_A, 'repo', 'bearer2');
    now += 500;
    const hit = cache.get(ID_A, 'repo');
    assert.ok(hit, 'entry should still be present after re-record extends TTL');
    assert.equal(hit.upstreamBearer, 'bearer2');
  });
});

describe('ProofCache LRU eviction', () => {
  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new ProofCache({ maxEntries: 2 });
    cache.record('id1', 'r', 'b1');
    cache.record('id2', 'r', 'b2');
    cache.record('id3', 'r', 'b3');
    assert.equal(cache.size(), 2);
    assert.equal(cache.get('id1', 'r'), null);
    assert.ok(cache.get('id2', 'r'));
    assert.ok(cache.get('id3', 'r'));
  });

  it('promotes accessed entries to the MRU end', () => {
    const cache = new ProofCache({ maxEntries: 2 });
    cache.record('id1', 'r', 'b1');
    cache.record('id2', 'r', 'b2');
    cache.get('id1', 'r');
    cache.record('id3', 'r', 'b3');
    assert.ok(cache.get('id1', 'r'), 'id1 should survive — it was just accessed');
    assert.equal(cache.get('id2', 'r'), null);
    assert.ok(cache.get('id3', 'r'));
  });
});

describe('ProofCache.invalidate', () => {
  it('drops the entry', () => {
    const cache = new ProofCache();
    cache.record(ID_A, 'repo', 'bearer');
    cache.invalidate(ID_A);
    assert.equal(cache.get(ID_A, 'repo'), null);
    assert.equal(cache.size(), 0);
  });

  it('is a no-op for unknown identities', () => {
    const cache = new ProofCache();
    cache.invalidate(ID_B);
    assert.equal(cache.size(), 0);
  });
});
