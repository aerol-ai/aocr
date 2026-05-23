import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createTokenExchangeAdapter } from '../upstreamAuth/adapters/tokenExchange';
import type { UpstreamCredentials } from '../upstreamAuth/wrap';

// A scriptable fake upstream that responds to /token and /v2/.../manifests/...
// with a configurable status + body. Tests mutate `state` to script each
// response.
type ScriptedResponse = {
  status: number;
  body?: unknown;
  // If true, simulate a TCP-level error by closing the socket without
  // writing a response.
  hangup?: boolean;
};

type ServerState = {
  tokenResponse: ScriptedResponse;
  manifestResponse: ScriptedResponse;
  capturedTokenAuth: string | null;
  capturedTokenQuery: URLSearchParams | null;
  capturedManifestAuth: string | null;
  capturedManifestUrl: string | null;
};

function defaultState(): ServerState {
  return {
    tokenResponse: { status: 200, body: { token: 'upstream-bearer' } },
    manifestResponse: { status: 200 },
    capturedTokenAuth: null,
    capturedTokenQuery: null,
    capturedManifestAuth: null,
    capturedManifestUrl: null,
  };
}

function startServer(state: ServerState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname === '/token') {
      state.capturedTokenAuth = req.headers.authorization ?? null;
      state.capturedTokenQuery = url.searchParams;
      respond(res, state.tokenResponse);
      return;
    }
    if (url.pathname.startsWith('/v2/') && url.pathname.includes('/manifests/')) {
      state.capturedManifestAuth = req.headers.authorization ?? null;
      state.capturedManifestUrl = url.pathname;
      respond(res, state.manifestResponse);
      return;
    }
    res.statusCode = 404;
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

function respond(res: http.ServerResponse, spec: ScriptedResponse): void {
  if (spec.hangup) {
    res.socket?.destroy();
    return;
  }
  res.statusCode = spec.status;
  if (spec.body !== undefined) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(spec.body));
  } else {
    res.end();
  }
}

const CREDS: UpstreamCredentials = {
  upstreamHost: 'example.test',
  username: 'octocat',
  password: 'p4ssw0rd',
  scope: 'unused-here',
};

describe('tokenExchangeAdapter', () => {
  let state: ServerState;
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    state = defaultState();
    const started = await startServer(state);
    baseUrl = started.baseUrl;
    close = started.close;
  });

  after(async () => {
    await close();
  });

  function adapter() {
    return createTokenExchangeAdapter({
      tokenEndpoint: `${baseUrl}/token`,
      manifestBase: baseUrl,
      service: 'test-service',
      timeoutMs: 2000,
    });
  }

  it('exchanges creds for a bearer and HEADs the manifest', async () => {
    Object.assign(state, defaultState());
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.deepEqual(result, { ok: true, upstreamBearer: 'upstream-bearer' });

    // Token endpoint received Basic auth with the right creds.
    const expectedBasic = Buffer.from('octocat:p4ssw0rd', 'utf8').toString('base64');
    assert.equal(state.capturedTokenAuth, `Basic ${expectedBasic}`);
    assert.equal(state.capturedTokenQuery?.get('service'), 'test-service');
    assert.equal(state.capturedTokenQuery?.get('scope'), 'repository:org/repo:pull');

    // Manifest HEAD used the bearer.
    assert.equal(state.capturedManifestAuth, 'Bearer upstream-bearer');
    assert.equal(state.capturedManifestUrl, '/v2/org/repo/manifests/latest');
  });

  it('accepts access_token alias from upstream', async () => {
    Object.assign(state, defaultState(), {
      tokenResponse: { status: 200, body: { access_token: 'alt-bearer' } },
    });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.deepEqual(result, { ok: true, upstreamBearer: 'alt-bearer' });
  });

  it('treats manifest 404 as ok (repo readable, tag absent)', async () => {
    Object.assign(state, defaultState(), { manifestResponse: { status: 404 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, true);
  });

  it('returns unauthorized when token endpoint says 401', async () => {
    Object.assign(state, defaultState(), { tokenResponse: { status: 401 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unauthorized');
  });

  it('returns unauthorized when token endpoint says 403', async () => {
    Object.assign(state, defaultState(), { tokenResponse: { status: 403 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unauthorized');
  });

  it('returns unauthorized when manifest HEAD says 401', async () => {
    Object.assign(state, defaultState(), { manifestResponse: { status: 401 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unauthorized');
  });

  it('returns unauthorized when manifest HEAD says 403', async () => {
    Object.assign(state, defaultState(), { manifestResponse: { status: 403 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unauthorized');
  });

  it('returns unreachable when token endpoint 5xx', async () => {
    Object.assign(state, defaultState(), { tokenResponse: { status: 503 } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unreachable');
  });

  it('returns unreachable when token endpoint omits the token field', async () => {
    Object.assign(state, defaultState(), {
      tokenResponse: { status: 200, body: { not_a_token: 'oops' } },
    });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unreachable');
  });

  it('returns unreachable on socket hangup', async () => {
    Object.assign(state, defaultState(), { tokenResponse: { status: 0, hangup: true } });
    const result = await adapter().probe(CREDS, 'org/repo');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unreachable');
  });

  it('rejects an empty repo path with unsupported', async () => {
    const result = await adapter().probe(CREDS, '');
    assert.equal(result.ok, false);
    if (result.ok === false) assert.equal(result.reason, 'unsupported');
  });
});
