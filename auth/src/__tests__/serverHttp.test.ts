import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';

import { createApp } from '../createApp';
import { MAX_REQUESTED_SCOPES } from '../scope';
import { ProofCache } from '../upstreamAuth/proofCache';
import {
  WRAPPED_UPSTREAM_TOKEN_PREFIX,
  WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS,
} from '../upstreamAuth/strategy';
import {
  credIdentity,
  parseWrapKeyRing,
  UpstreamCredentials,
  wrap,
} from '../upstreamAuth/wrap';

function generateJwtKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

function fakePool() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    pool: {
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (/FROM images/i.test(text)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ id: 'user-uuid-1' }], rowCount: 1 };
      },
      connect: async () => ({
        query: async (text: string, values: unknown[] = []) => {
          queries.push({ text, values });
          if (/INSERT INTO users/i.test(text)) {
            return { rows: [{ id: 'user-uuid-1' }] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    },
  };
}

async function request(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          // keep raw text
        }
        resolve({ status: res.statusCode || 0, body });
      });
    }).on('error', reject);
  });
}

describe('createApp HTTP routes', () => {
  const jwtPrivateKey = generateJwtKey();
  const { pool } = fakePool();
  let baseUrl = '';
  let closeServer: () => Promise<void>;

  before(async () => {
    const { app } = createApp({
      pool: pool as any,
      config: {
        authPatToken: 'admin-pat-token',
        authClusterPatTokens: 'cluster-abc=cluster-pat-token',
        jwtPrivateKey,
        defaultRegistryService: 'aocr-test',
      },
    });
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    closeServer = () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  after(async () => {
    await closeServer();
  });

  it('issues a JWT for a valid static PAT', async () => {
    const scope = encodeURIComponent('repository:acme/app:pull');
    const res = await request(
      baseUrl,
      `/v2/token?service=aocr-test&scope=${scope}`,
      { Authorization: 'Bearer admin-pat-token' },
    );
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.token === 'string');
    assert.equal(res.body.expires_in, 3600);
  });

  it('rejects an invalid static PAT', async () => {
    const res = await request(
      baseUrl,
      '/v2/token?service=aocr-test',
      { Authorization: 'Bearer wrong-token' },
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid token');
  });

  it('issues a JWT for a valid cluster PAT with allowed scope', async () => {
    const scope = encodeURIComponent('repository:cluster/cluster-abc/snap:pull');
    const res = await request(
      baseUrl,
      `/v2/token?service=aocr-test&scope=${scope}`,
      { Authorization: 'Bearer cluster-pat-token' },
    );
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.token === 'string');
  });

  it('rejects cluster PAT scope outside the cluster namespace', async () => {
    const scope = encodeURIComponent('repository:acme/private:pull');
    const res = await request(
      baseUrl,
      `/v2/token?service=aocr-test&scope=${scope}`,
      { Authorization: 'Bearer cluster-pat-token' },
    );
    assert.equal(res.status, 401);
  });

  it('lists images for admin PAT scope', async () => {
    const res = await request(
      baseUrl,
      '/v1/images?limit=10&offset=0',
      { Authorization: 'Bearer admin-pat-token' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'admin');
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.images, []);
  });

  it('rejects /v1/images for cluster PAT', async () => {
    const res = await request(
      baseUrl,
      '/v1/images',
      { Authorization: 'Bearer cluster-pat-token' },
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'unsupported_scope');
  });

  it('rejects /v1/images without auth', async () => {
    const res = await request(baseUrl, '/v1/images');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_token');
  });

  it('returns 401 when JWT signing key is missing', async () => {
    const { app } = createApp({
      pool: pool as any,
      config: {
        authPatToken: 'admin-pat-token',
      },
    });
    const server = app.listen(0);
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    const res = await request(
      url,
      '/v2/token?service=aocr-test',
      { Authorization: 'Bearer admin-pat-token' },
    );
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    assert.equal(res.status, 401);
  });
});

// containerd sends `scope` twice on every push (`repository:X:pull` and
// `repository:X:pull,push`), which Express parses as an array. These go through
// the real query parser so the array shape is what the handler actually sees.
describe('createApp /v2/token with repeated scope params', () => {
  const jwtPrivateKey = generateJwtKey();
  const wrapKey = crypto.randomBytes(32).toString('base64');
  const { pool, queries } = fakePool();
  let baseUrl = '';
  let closeServers: () => Promise<void>;
  let proofCache: ProofCache;

  const wrappedCreds: UpstreamCredentials = {
    upstreamHost: 'ghcr.io',
    username: 'octocat',
    password: 'ghp_xxxxxxxxxxxx',
    scope: 'repository:aocr/ghcr/aerol-ai/sandbox:pull',
  };

  function scopeQuery(...scopes: string[]): string {
    return scopes.map((scope) => `scope=${encodeURIComponent(scope)}`).join('&');
  }

  function accessOf(body: any): unknown {
    return (jwt.decode(body.token) as any).access;
  }

  function token(path: string, bearer: string) {
    return request(baseUrl, path, { Authorization: `Bearer ${bearer}` });
  }

  before(async () => {
    const validationServer = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ user: { id: 'api-user-1', username: 'alice' } }));
    });
    await new Promise<void>((resolve) => validationServer.listen(0, '127.0.0.1', resolve));
    const validationAddr = validationServer.address() as AddressInfo;

    const { app, validationContext } = createApp({
      pool: pool as any,
      config: {
        authPatToken: 'admin-pat-token',
        authClusterPatTokens: 'cluster-abc=cluster-pat-token',
        validationServiceUrl: `http://127.0.0.1:${validationAddr.port}`,
        upstreamAuthWrapKeys: `current:${wrapKey}`,
        jwtPrivateKey,
        defaultRegistryService: 'aocr-test',
      },
    });
    proofCache = validationContext.proofCache;
    const server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    closeServers = async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await new Promise<void>((resolve) => validationServer.close(() => resolve()));
    };
  });

  after(async () => {
    await closeServers();
  });

  it('issues pull+push for a cluster PAT push in containerd shape', async () => {
    const repo = 'cluster/cluster-abc/snapshots/x';
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(`repository:${repo}:pull`, `repository:${repo}:pull,push`)}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [{ type: 'repository', name: repo, actions: ['pull', 'push'] }]);
  });

  it('rejects a cluster PAT when any scope is another cluster namespace', async () => {
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:cluster/cluster-abc/snapshots/x:pull,push',
        'repository:cluster/cluster-other/snapshots/y:pull',
      )}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.token, undefined);
    assert.match(res.body.error, /cluster\/cluster-other\/snapshots\/y is outside/);
  });

  it('keeps per-scope cluster PAT decisions across several resources', async () => {
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:cluster/cluster-abc/snapshots/x:pull,push',
        'repository:mirror/library/alpine:pull,push',
      )}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'cluster/cluster-abc/snapshots/x', actions: ['pull', 'push'] },
      { type: 'repository', name: 'mirror/library/alpine', actions: ['pull'] },
    ]);
  });

  it('leaves a single cluster PAT scope unchanged', async () => {
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery('repository:mirror/library/alpine:pull,push')}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'mirror/library/alpine', actions: ['pull'] },
    ]);
  });

  it('issues every requested scope for a static PAT', async () => {
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:acme/app:pull',
        'repository:acme/app:pull,push',
        'repository:acme/base:pull',
      )}`,
      'admin-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'acme/app', actions: ['pull', 'push'] },
      { type: 'repository', name: 'acme/base', actions: ['pull'] },
    ]);
  });

  it('syncs every repository scope on the api path', async () => {
    queries.length = 0;
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:acme/app:pull',
        'repository:acme/app:pull,push',
        'repository:acme/base:pull',
        'registry:catalog:*',
      )}`,
      'api-user-token',
    );
    assert.equal(res.status, 200);
    const repoInserts = queries
      .filter((query) => /INSERT INTO repositories/i.test(query.text))
      .map((query) => query.values);
    assert.deepEqual(repoInserts, [
      ['acme', 'app', 'user-uuid-1'],
      ['acme', 'base', 'user-uuid-1'],
    ]);
    assert.ok(queries.some((query) => query.text === 'COMMIT'));
  });

  it('ignores a non-string entry in the scope array', async () => {
    // Express parses this as [string, { x: string }]. The object carries a
    // scope the cluster PAT may not use, so evaluating it would mean a 401.
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery('repository:cluster/cluster-abc/a:pull')}`
        + `&scope[x]=${encodeURIComponent('repository:acme/private:push')}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'cluster/cluster-abc/a', actions: ['pull'] },
    ]);
  });

  it('ignores a malformed entry in the scope array', async () => {
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery('no-colons', 'repository:cluster/cluster-abc/a:pull')}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'cluster/cluster-abc/a', actions: ['pull'] },
    ]);
  });

  it('issues an empty access list when scope arrives as an object', async () => {
    // Bracket keys mixed with plain repeats (or more than 20 repeats) make
    // Express hand the whole param over as an object; it grants nothing.
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery('no-colons', 'repository:cluster/cluster-abc/a:pull')}`
        + `&scope[x]=${encodeURIComponent('repository:acme/private:push')}`,
      'cluster-pat-token',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(accessOf(res.body), []);
  });

  it('rejects more distinct scopes than the per-request cap', async () => {
    const scopes = Array.from({ length: MAX_REQUESTED_SCOPES + 1 }, (_, i) => `repository:acme/r${i}:pull`);
    const res = await token(`/v2/token?service=aocr-test&${scopeQuery(scopes.join(' '))}`, 'admin-pat-token');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /too many scopes/);
  });

  it('proves and issues every repo for a wrapped-upstream token', async () => {
    const identity = credIdentity(wrappedCreds);
    proofCache.record(identity, 'aerol-ai/sandbox', 'bearer');
    proofCache.record(identity, 'aerol-ai/other', 'bearer');
    const blob = WRAPPED_UPSTREAM_TOKEN_PREFIX + wrap(parseWrapKeyRing(`current:${wrapKey}`), wrappedCreds);

    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:aocr/ghcr/aerol-ai/sandbox:pull',
        'repository:aocr/ghcr/aerol-ai/other:pull',
      )}`,
      blob,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.expires_in, WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS);
    assert.deepEqual(accessOf(res.body), [
      { type: 'repository', name: 'aocr/ghcr/aerol-ai/sandbox', actions: ['pull'] },
      { type: 'repository', name: 'aocr/ghcr/aerol-ai/other', actions: ['pull'] },
    ]);
  });

  it('rejects a wrapped-upstream token when a second scope is not provable', async () => {
    const identity = credIdentity(wrappedCreds);
    proofCache.record(identity, 'aerol-ai/sandbox', 'bearer');
    const blob = WRAPPED_UPSTREAM_TOKEN_PREFIX + wrap(parseWrapKeyRing(`current:${wrapKey}`), wrappedCreds);

    // The second scope routes to docker.io, not the envelope's ghcr.io, so it
    // is rejected before any upstream probe.
    const res = await token(
      `/v2/token?service=aocr-test&${scopeQuery(
        'repository:aocr/ghcr/aerol-ai/sandbox:pull',
        'repository:cluster/cluster-abc/secret:pull,push',
      )}`,
      blob,
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid token');
  });
});
