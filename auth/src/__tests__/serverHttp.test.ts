import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../createApp';

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
