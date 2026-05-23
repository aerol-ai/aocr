import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { ProofCache } from '../upstreamAuth/proofCache';
import {
  WRAPPED_UPSTREAM_MAX_AGE_MS,
  WRAPPED_UPSTREAM_TOKEN_PREFIX,
  WrappedUpstreamError,
  extractRepoFromScope,
  isWrappedUpstreamToken,
  validateWrappedUpstream,
} from '../upstreamAuth/strategy';
import type { ProbeResult, UpstreamProbe } from '../upstreamAuth/index';
import {
  UpstreamCredentials,
  WrapKeyRing,
  parseWrapKeyRing,
  wrap,
} from '../upstreamAuth/wrap';

function freshRing(): WrapKeyRing {
  const key = crypto.randomBytes(32).toString('base64');
  return parseWrapKeyRing(`current:${key}`);
}

const SAMPLE_CREDS: UpstreamCredentials = {
  upstreamHost: 'ghcr.io',
  username: 'octocat',
  password: 'ghp_xxxxxxxxxxxx',
  scope: 'repository:aocr/ghcr/aerol-ai/sandbox:pull',
};
const SCOPE = 'repository:aocr/ghcr/aerol-ai/sandbox:pull';
// Upstream-side repo after the route helper strips `aocr/ghcr/`. This is what
// the proof cache and probes see end-to-end.
const REPO = 'aerol-ai/sandbox';

class FixedProbe implements UpstreamProbe {
  public calls = 0;
  constructor(private readonly result: ProbeResult) {}
  async probe(): Promise<ProbeResult> {
    this.calls++;
    return this.result;
  }
}

function wrappedToken(ring: WrapKeyRing, creds: UpstreamCredentials, ts?: Date): string {
  return WRAPPED_UPSTREAM_TOKEN_PREFIX + wrap(ring, creds, ts);
}

describe('isWrappedUpstreamToken', () => {
  it('matches the aocrwrap: prefix', () => {
    assert.equal(isWrappedUpstreamToken('aocrwrap:abc'), true);
    assert.equal(isWrappedUpstreamToken('Bearer abc'), false);
    assert.equal(isWrappedUpstreamToken('pat_abc'), false);
  });
});

describe('extractRepoFromScope', () => {
  it('returns the name segment of repository scope strings', () => {
    assert.equal(extractRepoFromScope('repository:library/redis:pull'), 'library/redis');
    assert.equal(extractRepoFromScope('repository:aocr/ghcr/org/repo:pull,push'), 'aocr/ghcr/org/repo');
  });

  it('returns null for empty / non-string / malformed input', () => {
    assert.equal(extractRepoFromScope(undefined), null);
    assert.equal(extractRepoFromScope(''), null);
    assert.equal(extractRepoFromScope('no-colon'), null);
    assert.equal(extractRepoFromScope(42), null);
  });
});

describe('validateWrappedUpstream success path', () => {
  it('decrypts, probes once, and caches the proof', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    const probe = new FixedProbe({ ok: true, upstreamBearer: 'upstream-token' });

    const token = wrappedToken(ring, SAMPLE_CREDS);
    const r1 = await validateWrappedUpstream(token, SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    assert.equal(r1.cacheHit, false);
    assert.equal(probe.calls, 1);
    assert.match(r1.identity, /^[0-9a-f]{64}$/);

    // Second call with a fresh blob (different nonce) should hit cache —
    // identity collapses to the same key.
    const token2 = wrappedToken(ring, SAMPLE_CREDS);
    const r2 = await validateWrappedUpstream(token2, SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    assert.equal(r2.cacheHit, true);
    assert.equal(probe.calls, 1, 'no second probe — proof cache served it');
    assert.equal(r2.identity, r1.identity);
  });

  it('re-probes when same creds request a different repo', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    const probe = new FixedProbe({ ok: true, upstreamBearer: 'upstream-token' });

    await validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    const otherScope = 'repository:aocr/ghcr/aerol-ai/other:pull';
    await validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), otherScope, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    assert.equal(probe.calls, 2, 'second repo requires its own probe');
  });
});

describe('validateWrappedUpstream rejection', () => {
  it('rejects when no wrap keys are configured', async () => {
    const cache = new ProofCache();
    await assert.rejects(
      validateWrappedUpstream(
        wrappedToken(freshRing(), SAMPLE_CREDS),
        SCOPE,
        { keyRing: parseWrapKeyRing(''), proofCache: cache },
      ),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'not_configured',
    );
  });

  it('rejects a token without the aocrwrap: prefix', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    await assert.rejects(
      validateWrappedUpstream('Bearer not-a-wrap', SCOPE, { keyRing: ring, proofCache: cache }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'invalid_blob',
    );
  });

  it('rejects a blob the ring cannot decrypt', async () => {
    const a = freshRing();
    const b = freshRing();
    const cache = new ProofCache();
    const token = wrappedToken(a, SAMPLE_CREDS);
    await assert.rejects(
      validateWrappedUpstream(token, SCOPE, { keyRing: b, proofCache: cache }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'invalid_blob',
    );
  });

  it('rejects a blob older than the max age (replay defense)', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    const staleAt = new Date(Date.now() - WRAPPED_UPSTREAM_MAX_AGE_MS - 1000);
    const token = wrappedToken(ring, SAMPLE_CREDS, staleAt);
    await assert.rejects(
      validateWrappedUpstream(token, SCOPE, { keyRing: ring, proofCache: cache }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'expired',
    );
  });

  it('invalidates the cached proof on upstream 401', async () => {
    const ring = freshRing();
    const cache = new ProofCache();

    // Seed the cache with a successful proof.
    const ok = new FixedProbe({ ok: true, upstreamBearer: 'good' });
    const first = await validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => ok,
    });
    assert.ok(cache.get(first.identity, REPO));

    // Now the user rotates their password upstream — wrap with new creds,
    // probe returns unauthorized — cache for the NEW identity must NOT be
    // populated. The OLD identity is unrelated; this test verifies the
    // invalidation is keyed correctly.
    const badCreds = { ...SAMPLE_CREDS, password: 'rotated-password' };
    const badProbe = new FixedProbe({ ok: false, reason: 'unauthorized' });
    await assert.rejects(
      validateWrappedUpstream(wrappedToken(ring, badCreds), SCOPE, {
        keyRing: ring,
        proofCache: cache,
        resolveProbe: () => badProbe,
      }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'unauthorized',
    );
  });

  it('does not invalidate cache when probe reports unreachable (transient)', async () => {
    const ring = freshRing();
    const cache = new ProofCache();

    // Seed cache.
    const ok = new FixedProbe({ ok: true, upstreamBearer: 'good' });
    const seeded = await validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => ok,
    });

    // A different repo against the same identity probes again; that probe
    // is transiently unreachable. The cached proof for REPO must remain.
    const otherScope = 'repository:aocr/ghcr/aerol-ai/other:pull';
    const flaky = new FixedProbe({ ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' });
    await assert.rejects(
      validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), otherScope, {
        keyRing: ring,
        proofCache: cache,
        resolveProbe: () => flaky,
      }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'unreachable',
    );
    assert.ok(cache.get(seeded.identity, REPO), 'original proof must survive a transient miss');
  });
});

describe('validateWrappedUpstream routing', () => {
  it('rejects when the scope routes to a different host than the envelope', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    const probe = new FixedProbe({ ok: true, upstreamBearer: 'x' });
    // Envelope says ghcr.io, but scope says docker.io's library/redis.
    const mismatchScope = 'repository:library/redis:pull';
    await assert.rejects(
      validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), mismatchScope, {
        keyRing: ring,
        proofCache: cache,
        resolveProbe: () => probe,
      }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'route_mismatch',
    );
    assert.equal(probe.calls, 0, 'must not probe when routing fails');
  });

  it('rejects an unknown aocr/ reserved prefix', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    const probe = new FixedProbe({ ok: true, upstreamBearer: 'x' });
    const unknownScope = 'repository:aocr/unknown/foo/bar:pull';
    await assert.rejects(
      validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), unknownScope, {
        keyRing: ring,
        proofCache: cache,
        resolveProbe: () => probe,
      }),
      (err: unknown) => err instanceof WrappedUpstreamError && err.code === 'route_mismatch',
    );
  });

  it('strips the aocr/ghcr/ prefix before handing the repo to the probe', async () => {
    const ring = freshRing();
    const cache = new ProofCache();
    let observedRepo = '';
    const probe = {
      async probe(_creds: UpstreamCredentials, repo: string) {
        observedRepo = repo;
        return { ok: true as const, upstreamBearer: 'x' };
      },
    };
    await validateWrappedUpstream(wrappedToken(ring, SAMPLE_CREDS), SCOPE, {
      keyRing: ring,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    assert.equal(observedRepo, 'aerol-ai/sandbox');
  });
});

describe('validateWrappedUpstream key rotation', () => {
  it('decrypts blobs wrapped under the previous key after rotation', async () => {
    const oldB64 = crypto.randomBytes(32).toString('base64');
    const newB64 = crypto.randomBytes(32).toString('base64');

    const beforeRotation = parseWrapKeyRing(`old:${oldB64}`);
    const token = wrappedToken(beforeRotation, SAMPLE_CREDS);

    const afterRotation = parseWrapKeyRing(`new:${newB64},old:${oldB64}`);
    const cache = new ProofCache();
    const probe = new FixedProbe({ ok: true, upstreamBearer: '' });
    const result = await validateWrappedUpstream(token, SCOPE, {
      keyRing: afterRotation,
      proofCache: cache,
      resolveProbe: () => probe,
    });
    assert.equal(result.cacheHit, false);
    assert.match(result.identity, /^[0-9a-f]{64}$/);
  });
});
