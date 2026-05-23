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

// Stub adapter used in PR 4b. Returns ok with an empty bearer for any
// upstream, which means: "we accept the wrap envelope as proof of identity
// but we have not actually contacted the upstream." Acceptable for the
// infrastructure-only PR because the wrap key is only shared with trusted
// AerolVM nodes, so an attacker without the wrap key cannot reach this code
// path. PR 4c replaces this with real per-upstream adapters that perform
// the token exchange and manifest HEAD described in F17 step 3-4.
class StubProbe implements UpstreamProbe {
  async probe(_creds: UpstreamCredentials, _repoPath: string): Promise<ProbeResult> {
    return { ok: true, upstreamBearer: '' };
  }
}

const STUB_PROBE = new StubProbe();

// Registry of probes by upstream host. PR 4b: every host resolves to the
// stub. PR 4c: replaced with real adapters.
const PROBES: Map<string, UpstreamProbe> = new Map();

export function getProbeForHost(host: string): UpstreamProbe {
  return PROBES.get(host.toLowerCase()) ?? STUB_PROBE;
}

// Test-only: register a probe for a host. Production registration happens
// during module init in PR 4c.
export function _registerProbeForTest(host: string, probe: UpstreamProbe): () => void {
  const prev = PROBES.get(host.toLowerCase());
  PROBES.set(host.toLowerCase(), probe);
  return () => {
    if (prev) PROBES.set(host.toLowerCase(), prev);
    else PROBES.delete(host.toLowerCase());
  };
}
