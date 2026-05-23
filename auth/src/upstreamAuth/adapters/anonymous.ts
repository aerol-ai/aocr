// Anonymous-pull adapter for upstreams that do not require authentication
// (registry.k8s.io as of Day 1). HEADs the manifest endpoint without any
// Authorization header. Returns an empty bearer on success — the mirror's
// subsequent S3-miss fetches can also be made anonymously.

import axios, { AxiosError } from 'axios';

import { UpstreamCredentials } from '../wrap';
import { ProbeResult, UpstreamProbe } from '../index';

export type AnonymousConfig = {
  manifestBase: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8000;
const PROBE_REFERENCE = 'latest';

export function createAnonymousAdapter(config: AnonymousConfig): UpstreamProbe {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probe(_creds: UpstreamCredentials, repoPath: string): Promise<ProbeResult> {
      if (!repoPath) {
        return { ok: false, reason: 'unsupported', detail: 'empty repo path' };
      }
      const manifestUrl = `${trimTrailingSlash(config.manifestBase)}/v2/${repoPath}/manifests/${PROBE_REFERENCE}`;
      let status: number;
      try {
        const resp = await axios.request({
          url: manifestUrl,
          method: 'HEAD',
          timeout: timeoutMs,
          validateStatus: (s) => s >= 200 && s < 500,
        });
        status = resp.status;
      } catch (err) {
        return { ok: false, reason: 'unreachable', detail: describeAxiosError(err) };
      }
      if (status === 401 || status === 403) {
        // Should not happen for a truly anonymous registry — surfaces a
        // misconfiguration (the upstream now requires auth).
        return { ok: false, reason: 'unauthorized', detail: `anonymous manifest HEAD returned ${status}` };
      }
      if (status === 200 || status === 202 || status === 404) {
        return { ok: true, upstreamBearer: '' };
      }
      return { ok: false, reason: 'unreachable', detail: `manifest HEAD returned ${status}` };
    },
  };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function describeAxiosError(err: unknown): string {
  if (err instanceof AxiosError) {
    return err.code ? `${err.code}: ${err.message}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
