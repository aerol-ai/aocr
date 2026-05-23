import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createAnonymousAdapter } from '../upstreamAuth/adapters/anonymous';
import type { UpstreamCredentials } from '../upstreamAuth/wrap';

type ServerState = {
  manifestStatus: number;
  capturedAuth: string | null;
  capturedUrl: string | null;
};

function startServer(state: ServerState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    state.capturedAuth = req.headers.authorization ?? null;
    state.capturedUrl = req.url ?? null;
    res.statusCode = state.manifestStatus;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const CREDS: UpstreamCredentials = {
  upstreamHost: 'anon.test',
  username: '',
  password: '',
  scope: 'unused',
};

describe('anonymousAdapter', () => {
  let state: ServerState;
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    state = { manifestStatus: 200, capturedAuth: null, capturedUrl: null };
    const started = await startServer(state);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  function adapter() {
    return createAnonymousAdapter({ manifestBase: baseUrl, timeoutMs: 2000 });
  }

  it('HEADs the manifest without an Authorization header', async () => {
    state.manifestStatus = 200;
    state.capturedAuth = 'sentinel';
    const result = await adapter().probe(CREDS, 'pause');
    assert.deepEqual(result, { ok: true, upstreamBearer: '' });
    assert.equal(state.capturedAuth, null);
    assert.equal(state.capturedUrl, '/v2/pause/manifests/latest');
  });

  it('treats 404 as ok', async () => {
    state.manifestStatus = 404;
    const result = await adapter().probe(CREDS, 'pause');
    assert.equal(result.ok, true);
  });

  it('returns unauthorized when registry suddenly requires auth', async () => {
    state.manifestStatus = 401;
    const result = await adapter().probe(CREDS, 'pause');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unauthorized');
  });

  it('returns unreachable on 5xx', async () => {
    state.manifestStatus = 503;
    const result = await adapter().probe(CREDS, 'pause');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unreachable');
  });

  it('rejects empty repo path', async () => {
    const result = await adapter().probe(CREDS, '');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unsupported');
  });
});
