import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  WrapError,
  WrapKeyRing,
  credIdentity,
  parseWrapKeyRing,
  unwrap,
  wrap,
  type UpstreamCredentials,
} from '../upstreamAuth/wrap';

function randomKeyB64(): string {
  return crypto.randomBytes(32).toString('base64');
}

function ringOf(...b64s: string[]): WrapKeyRing {
  return parseWrapKeyRing(b64s.map((b, i) => `k${i}:${b}`).join(','));
}

const SAMPLE_CREDS: UpstreamCredentials = {
  upstreamHost: 'ghcr.io',
  username: 'octocat',
  password: 'ghp_thisIsATokenValue',
  scope: 'repository:aerol-ai/sandbox:pull',
};

describe('parseWrapKeyRing', () => {
  it('returns empty ring for null/undefined/empty', () => {
    assert.deepEqual(parseWrapKeyRing(undefined).keys, []);
    assert.deepEqual(parseWrapKeyRing(null).keys, []);
    assert.deepEqual(parseWrapKeyRing('').keys, []);
    assert.deepEqual(parseWrapKeyRing('   ').keys, []);
  });

  it('parses a single bare key and assigns synthetic id', () => {
    const b64 = randomKeyB64();
    const ring = parseWrapKeyRing(b64);
    assert.equal(ring.keys.length, 1);
    assert.equal(ring.keys[0].id, 'k0');
    assert.equal(ring.keys[0].bytes.length, 32);
  });

  it('parses prefixed ids, preserves order, tolerates whitespace', () => {
    const a = randomKeyB64();
    const b = randomKeyB64();
    const ring = parseWrapKeyRing(`  current:${a} , old:${b}  `);
    assert.equal(ring.keys.length, 2);
    assert.equal(ring.keys[0].id, 'current');
    assert.equal(ring.keys[1].id, 'old');
  });

  it('skips entries that decode to wrong length', () => {
    const tooShort = Buffer.alloc(16).toString('base64');
    const good = randomKeyB64();
    const ring = parseWrapKeyRing(`${tooShort},${good}`);
    assert.equal(ring.keys.length, 1);
    assert.equal(ring.keys[0].bytes.length, 32);
  });
});

describe('wrap/unwrap round-trip', () => {
  it('returns the same creds and a recent timestamp', () => {
    const ring = ringOf(randomKeyB64());
    const before = Date.now();
    const blob = wrap(ring, SAMPLE_CREDS);
    const result = unwrap(ring, blob);
    const after = Date.now();

    assert.deepEqual(result.creds, SAMPLE_CREDS);
    assert.equal(result.keyId, 'k0');
    assert.ok(result.wrappedAt.getTime() >= before);
    assert.ok(result.wrappedAt.getTime() <= after);
    assert.ok(result.ageMs >= 0 && result.ageMs < 1000);
  });

  it('produces a different blob each time (random nonce)', () => {
    const ring = ringOf(randomKeyB64());
    const a = wrap(ring, SAMPLE_CREDS);
    const b = wrap(ring, SAMPLE_CREDS);
    assert.notEqual(a, b);
  });

  it('reports the elapsed age for stale blobs', () => {
    const ring = ringOf(randomKeyB64());
    const past = new Date(Date.now() - 60_000);
    const blob = wrap(ring, SAMPLE_CREDS, past);
    const result = unwrap(ring, blob);
    assert.ok(result.ageMs >= 60_000);
  });
});

describe('key ring rotation', () => {
  it('decrypts a blob wrapped under an older key after rotation', () => {
    const oldB64 = randomKeyB64();
    const newB64 = randomKeyB64();

    const oldRing = parseWrapKeyRing(`old:${oldB64}`);
    const blob = wrap(oldRing, SAMPLE_CREDS);

    const rotatedRing = parseWrapKeyRing(`new:${newB64},old:${oldB64}`);
    const result = unwrap(rotatedRing, blob);
    assert.deepEqual(result.creds, SAMPLE_CREDS);
    assert.equal(result.keyId, 'old');
  });

  it('uses the first key to wrap', () => {
    const a = randomKeyB64();
    const b = randomKeyB64();
    const ring = parseWrapKeyRing(`first:${a},second:${b}`);
    const blob = wrap(ring, SAMPLE_CREDS);

    const justFirst = parseWrapKeyRing(`first:${a}`);
    const result = unwrap(justFirst, blob);
    assert.equal(result.keyId, 'first');
  });
});

describe('unwrap rejection', () => {
  it('throws unknown_key when no key in ring matches', () => {
    const a = ringOf(randomKeyB64());
    const blob = wrap(a, SAMPLE_CREDS);
    const b = ringOf(randomKeyB64());
    assert.throws(
      () => unwrap(b, blob),
      (err: unknown) => err instanceof WrapError && err.code === 'unknown_key'
    );
  });

  it('throws unknown_key for an empty ring', () => {
    const empty = parseWrapKeyRing('');
    assert.throws(
      () => unwrap(empty, 'anything'),
      (err: unknown) => err instanceof WrapError && err.code === 'unknown_key'
    );
  });

  it('throws invalid_format for blobs that are too short', () => {
    const ring = ringOf(randomKeyB64());
    const tiny = Buffer.alloc(5).toString('base64url');
    assert.throws(
      () => unwrap(ring, tiny),
      (err: unknown) => err instanceof WrapError && err.code === 'invalid_format'
    );
  });

  it('throws unknown_key when the auth tag has been tampered with', () => {
    const ring = ringOf(randomKeyB64());
    const blob = wrap(ring, SAMPLE_CREDS);
    const raw = Buffer.from(blob, 'base64url');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64url');
    assert.throws(
      () => unwrap(ring, tampered),
      (err: unknown) => err instanceof WrapError && err.code === 'unknown_key'
    );
  });
});

describe('credIdentity', () => {
  it('is stable across calls', () => {
    assert.equal(credIdentity(SAMPLE_CREDS), credIdentity(SAMPLE_CREDS));
  });

  it('changes when host, username, or password change', () => {
    const base = credIdentity(SAMPLE_CREDS);
    assert.notEqual(base, credIdentity({ ...SAMPLE_CREDS, upstreamHost: 'docker.io' }));
    assert.notEqual(base, credIdentity({ ...SAMPLE_CREDS, username: 'other' }));
    assert.notEqual(base, credIdentity({ ...SAMPLE_CREDS, password: 'other' }));
  });

  it('does NOT change when scope changes (same creds, different repo)', () => {
    const a = credIdentity(SAMPLE_CREDS);
    const b = credIdentity({ ...SAMPLE_CREDS, scope: 'repository:other/repo:pull' });
    assert.equal(a, b);
  });

  it('returns a 64-char hex string (sha256)', () => {
    const id = credIdentity(SAMPLE_CREDS);
    assert.match(id, /^[0-9a-f]{64}$/);
  });
});
