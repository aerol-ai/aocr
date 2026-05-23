// F20 / F17 glue: probe interface and the dispatch from upstream host to
// adapter. PR 4b ships ONLY the stub adapter (anonymous HEAD); the real
// per-upstream adapters (DockerHub token exchange, ghcr.io, quay, gcr, etc.)
// land in PR 4c. The interface and the strategy code calling it are stable
// across both PRs so 4c is purely additive.

import { UpstreamCredentials } from './wrap';

export type ProbeOk = {
  ok: true;
  // Opaque bearer the mirror can reuse for blob/manifest fetches within the
  // proof window. May be empty for upstreams that allow anonymous reads
  // (the registry.k8s.io case, and the PR 4b stub).
  upstreamBearer: string;
};

export type ProbeErr = {
  ok: false;
  // 'unauthorized' = upstream said the creds are invalid for this repo (401
  // or 403). The auth service surfaces this to the client and invalidates
  // any cached proof. 'unreachable' = transient/networking; the auth service
  // returns 502 without invalidating the cache. 'unsupported' = the host
  // has no adapter registered.
  reason: 'unauthorized' | 'unreachable' | 'unsupported';
  detail?: string;
};

export type ProbeResult = ProbeOk | ProbeErr;

export interface UpstreamProbe {
  // Verify the creds can read `repoPath` on the upstream.
  probe(creds: UpstreamCredentials, repoPath: string): Promise<ProbeResult>;
}

// Unknown-host probe. Returned when no adapter is registered for the
// upstream host carried in the wrap envelope. Always rejects with
// 'unsupported' so the auth service produces a clear error rather than
// silently accepting an unauthenticated identity.
class UnsupportedProbe implements UpstreamProbe {
  async probe(_creds: UpstreamCredentials, _repoPath: string): Promise<ProbeResult> {
    return { ok: false, reason: 'unsupported', detail: 'no adapter registered for this upstream' };
  }
}

const UNSUPPORTED_PROBE = new UnsupportedProbe();

// Registry of probes by upstream host. Populated at module init below with
// the Day-1 adapters; tests can swap entries via _registerProbeForTest.
const PROBES: Map<string, UpstreamProbe> = new Map();

export function getProbeForHost(host: string): UpstreamProbe {
  return PROBES.get(host.toLowerCase()) ?? UNSUPPORTED_PROBE;
}

// Test-only: register a probe for a host. Returns a restore function the
// test should call in afterEach. Production registration happens at module
// load via registerDefaultProbes() below.
export function _registerProbeForTest(host: string, probe: UpstreamProbe): () => void {
  const prev = PROBES.get(host.toLowerCase());
  PROBES.set(host.toLowerCase(), probe);
  return () => {
    if (prev) PROBES.set(host.toLowerCase(), prev);
    else PROBES.delete(host.toLowerCase());
  };
}

// Day-1 upstream endpoint table. The values are the public token-server +
// manifest endpoints for each upstream. Kept here (not env-tunable) because
// changing them is a code-review decision, not an operator decision.
import { createTokenExchangeAdapter } from './adapters/tokenExchange';
import { createAnonymousAdapter } from './adapters/anonymous';

function registerDefaultProbes(): void {
  PROBES.set('docker.io', createTokenExchangeAdapter({
    tokenEndpoint: 'https://auth.docker.io/token',
    manifestBase: 'https://registry-1.docker.io',
    service: 'registry.docker.io',
  }));
  PROBES.set('ghcr.io', createTokenExchangeAdapter({
    tokenEndpoint: 'https://ghcr.io/token',
    manifestBase: 'https://ghcr.io',
    service: 'ghcr.io',
  }));
  PROBES.set('quay.io', createTokenExchangeAdapter({
    tokenEndpoint: 'https://quay.io/v2/auth',
    manifestBase: 'https://quay.io',
    service: 'quay.io',
  }));
  PROBES.set('gcr.io', createTokenExchangeAdapter({
    // GCR's /v2/token endpoint accepts `_json_key:<json>` Basic-auth and
    // performs the OAuth2 service-account exchange internally, so the
    // generic adapter works without a dedicated OAuth2 code path here.
    tokenEndpoint: 'https://gcr.io/v2/token',
    manifestBase: 'https://gcr.io',
    service: 'gcr.io',
  }));
  PROBES.set('registry.k8s.io', createAnonymousAdapter({
    manifestBase: 'https://registry.k8s.io',
  }));
}

registerDefaultProbes();
