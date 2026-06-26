import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildClusterPatConfig,
  buildClusterPatProfile,
  buildStaticPatConfig,
  buildWrappedUpstreamProfile,
  computeLibtrustKeyId,
  extractPresentedCredentials,
  getDatabaseConnectionString,
  getValidationInfoUrl,
  normalizeValidationProfile,
  parseStaticPatTokens,
  presentedIdentityMatchesUser,
  tokensMatch,
  validateUsingClusterPat,
  validateUsingStaticPat,
  STATIC_PAT_SUBJECT,
} from '../serverHelpers';

describe('computeLibtrustKeyId', () => {
  it('returns a colon-separated base32 kid for an RSA key', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const kid = computeLibtrustKeyId(pem);
    assert.match(kid, /^[A-Z2-7]{4}(:[A-Z2-7]{4})+$/);
    assert.equal(computeLibtrustKeyId(pem), kid);
  });
});

describe('getDatabaseConnectionString', () => {
  it('returns DATABASE_URL when set', () => {
    assert.equal(
      getDatabaseConnectionString({ DATABASE_URL: 'postgres://u:p@host/db' } as NodeJS.ProcessEnv),
      'postgres://u:p@host/db',
    );
  });

  it('builds a URL from POSTGRES_* parts with encoding', () => {
    const url = getDatabaseConnectionString({
      POSTGRES_HOST: 'db.local',
      POSTGRES_DB: 'aocr',
      POSTGRES_USER: 'user@x',
      POSTGRES_PASSWORD: 'p@ss',
      POSTGRES_PORT: '5433',
    } as NodeJS.ProcessEnv);
    assert.equal(url, 'postgres://user%40x:p%40ss@db.local:5433/aocr');
  });

  it('throws when neither DATABASE_URL nor POSTGRES_* are complete', () => {
    assert.throws(
      () => getDatabaseConnectionString({ POSTGRES_HOST: 'db.local' } as NodeJS.ProcessEnv),
      /must be configured/,
    );
  });
});

describe('parseStaticPatTokens', () => {
  it('dedupes comma- and newline-separated tokens', () => {
    assert.deepEqual(parseStaticPatTokens('a,b', 'b\nc'), ['a', 'b', 'c']);
  });

  it('ignores blank entries', () => {
    assert.deepEqual(parseStaticPatTokens('  ,  ,tok  '), ['tok']);
  });
});

describe('buildStaticPatConfig', () => {
  it('returns null when no tokens are configured', () => {
    assert.equal(buildStaticPatConfig(undefined, undefined), null);
  });

  it('builds a static-pat profile for configured tokens', () => {
    const cfg = buildStaticPatConfig('secret-pat', undefined);
    assert.ok(cfg);
    assert.deepEqual(cfg!.tokens, ['secret-pat']);
    assert.equal(cfg!.userProfile.externalId, STATIC_PAT_SUBJECT);
  });
});

describe('tokensMatch', () => {
  it('compares tokens in constant time', () => {
    assert.equal(tokensMatch('abc', 'abc'), true);
    assert.equal(tokensMatch('abc', 'abd'), false);
    assert.equal(tokensMatch('abc', 'ab'), false);
  });
});

describe('extractPresentedCredentials', () => {
  it('parses Bearer tokens', () => {
    assert.deepEqual(extractPresentedCredentials('Bearer my-token'), {
      validationToken: 'my-token',
      presentedIdentity: null,
    });
  });

  it('parses Basic auth with username and password', () => {
    const encoded = Buffer.from('alice:registry-token').toString('base64');
    assert.deepEqual(extractPresentedCredentials(`Basic ${encoded}`), {
      validationToken: 'registry-token',
      presentedIdentity: 'alice',
    });
  });

  it('rejects missing auth header', () => {
    assert.throws(() => extractPresentedCredentials(undefined), /Auth token required/);
  });

  it('rejects Basic auth without a password', () => {
    const encoded = Buffer.from('alice:').toString('base64');
    assert.throws(() => extractPresentedCredentials(`Basic ${encoded}`), /Registry token required/);
  });

  it('rejects unsupported schemes', () => {
    assert.throws(() => extractPresentedCredentials('Digest abc'), /Unsupported authorization scheme/);
  });
});

describe('getValidationInfoUrl', () => {
  it('appends /api/auth/info when missing', () => {
    assert.equal(getValidationInfoUrl('https://auth.example.com'), 'https://auth.example.com/api/auth/info');
  });

  it('preserves an already-suffixed URL', () => {
    assert.equal(
      getValidationInfoUrl('https://auth.example.com/api/auth/info'),
      'https://auth.example.com/api/auth/info',
    );
  });

  it('throws when validation service URL is missing', () => {
    assert.throws(() => getValidationInfoUrl(undefined), /VALIDATION_SERVICE_URL not configured/);
  });
});

describe('normalizeValidationProfile', () => {
  it('maps nested user payloads', () => {
    const profile = normalizeValidationProfile({
      authProvider: 'github',
      user: {
        id: '42',
        username: 'octo',
        email: 'octo@example.com',
        name: 'Octo Cat',
        avatar: 'https://example.com/a.png',
      },
    });
    assert.equal(profile.externalId, '42');
    assert.equal(profile.username, 'octo');
    assert.equal(profile.email, 'octo@example.com');
    assert.equal(profile.displayName, 'Octo Cat');
    assert.equal(profile.avatarUrl, 'https://example.com/a.png');
    assert.equal(profile.authProvider, 'github');
  });

  it('throws when user id is missing', () => {
    assert.throws(() => normalizeValidationProfile({ user: {} }), /did not return a user id/);
  });
});

describe('presentedIdentityMatchesUser', () => {
  const profile = {
    externalId: 'user-1',
    username: 'alice',
    email: 'alice@example.com',
    displayName: null,
    avatarUrl: null,
    authProvider: null,
    rawProfile: {},
  };

  it('passes when no identity is presented', () => {
    assert.equal(presentedIdentityMatchesUser(null, undefined, profile), true);
  });

  it('matches username case-insensitively', () => {
    assert.equal(presentedIdentityMatchesUser('Alice', null, profile), true);
  });

  it('rejects mismatched account names', () => {
    assert.equal(presentedIdentityMatchesUser('bob', 'bob', profile), false);
  });
});

describe('validateUsingStaticPat', () => {
  it('returns a pat result for a configured token', () => {
    const cfg = buildStaticPatConfig('good-pat', undefined)!;
    const result = validateUsingStaticPat('good-pat', cfg);
    assert.equal(result?.strategy, 'pat');
  });

  it('returns null for unknown tokens', () => {
    const cfg = buildStaticPatConfig('good-pat', undefined)!;
    assert.equal(validateUsingStaticPat('bad-pat', cfg), null);
  });
});

describe('validateUsingClusterPat', () => {
  it('returns cluster-pat result for a configured token', () => {
    const cfg = buildClusterPatConfig('cluster-abc=cluster-secret')!;
    const result = validateUsingClusterPat('cluster-secret', cfg);
    assert.equal(result?.strategy, 'cluster-pat');
    assert.equal(result?.clusterId, 'cluster-abc');
  });
});

describe('buildClusterPatProfile / buildWrappedUpstreamProfile', () => {
  it('builds cluster subject names', () => {
    assert.equal(buildClusterPatProfile('abc').externalId, 'cluster:abc');
  });

  it('truncates wrapped upstream identity in the subject', () => {
    const identity = 'a'.repeat(32);
    assert.equal(buildWrappedUpstreamProfile(identity).externalId, `wrapped:${'a'.repeat(16)}`);
  });
});
