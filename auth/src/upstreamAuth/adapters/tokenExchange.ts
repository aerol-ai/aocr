// Generic /v2/token adapter. DockerHub, ghcr.io, quay.io, and gcr.io all
// implement the Distribution token-server spec
// (https://distribution.github.io/distribution/spec/auth/token/):
//
//   GET <tokenEndpoint>?service=<service>&scope=repository:<repo>:pull
//   Authorization: Basic base64(user:password)
//   → 200 {"token": "..."}   or 200 {"access_token": "..."}
//   → 401  if creds rejected
//
// Then a HEAD against the manifest endpoint with the issued bearer:
//   HEAD <manifestBase>/v2/<repo>/manifests/latest
//   Authorization: Bearer <token>
//   → 200/202 (manifest exists) or 404 (tag missing but repo readable) = ok
//   → 401/403 = unauthorized
//
// GCR shape: the username for service-account creds is `_json_key` and the
// password is the entire JSON. GCR's /v2/token endpoint does the internal
// OAuth2 exchange for us, so the same flow works — no separate OAuth2
// code path is required at this layer.

import axios, { AxiosError, AxiosRequestConfig } from 'axios';

import { UpstreamCredentials } from '../wrap';
import { ProbeResult, UpstreamProbe } from '../index';

export type TokenExchangeConfig = {
  // e.g. "https://auth.docker.io/token"
  tokenEndpoint: string;
  // e.g. "https://registry-1.docker.io" — the v2 path is appended.
  manifestBase: string;
  // The `service=` query param the upstream's token endpoint expects.
  service: string;
  // Per-request timeout. Defaults conservatively; the proof cache means
  // the slow path runs at most once per 5 minutes per (creds, repo).
  timeoutMs?: number;
};

type TokenResponse = {
  token?: string;
  access_token?: string;
};

const DEFAULT_TIMEOUT_MS = 8000;
// The probe HEADs `manifests/<reference>` to confirm read perm on the repo.
// We use `latest` as a benign reference — even when the tag does not exist,
// the upstream returns 404 (not 401) which still proves the bearer was
// accepted for the repo. The probe is not validating a specific tag, only
// access to the repo.
const PROBE_REFERENCE = 'latest';

export function createTokenExchangeAdapter(config: TokenExchangeConfig): UpstreamProbe {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async probe(creds: UpstreamCredentials, repoPath: string): Promise<ProbeResult> {
      if (!repoPath) {
        return { ok: false, reason: 'unsupported', detail: 'empty repo path' };
      }

      // 1) Exchange creds for an upstream bearer.
      const basic = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
      const tokenReq: AxiosRequestConfig = {
        url: config.tokenEndpoint,
        method: 'GET',
        params: {
          service: config.service,
          scope: `repository:${repoPath}:pull`,
        },
        headers: { Authorization: `Basic ${basic}` },
        timeout: timeoutMs,
        // Accept any 2xx/4xx so we can map status codes to ProbeResult
        // codes ourselves. 5xx and network errors throw.
        validateStatus: (s) => s >= 200 && s < 500,
      };

      let tokenStatus: number;
      let tokenBody: TokenResponse;
      try {
        const resp = await axios.request<TokenResponse>(tokenReq);
        tokenStatus = resp.status;
        tokenBody = resp.data ?? {};
      } catch (err) {
        return { ok: false, reason: 'unreachable', detail: describeAxiosError(err) };
      }
      if (tokenStatus === 401 || tokenStatus === 403) {
        return { ok: false, reason: 'unauthorized', detail: `token endpoint returned ${tokenStatus}` };
      }
      if (tokenStatus !== 200) {
        return { ok: false, reason: 'unreachable', detail: `token endpoint returned ${tokenStatus}` };
      }
      const bearer = tokenBody.token ?? tokenBody.access_token;
      if (!bearer) {
        return { ok: false, reason: 'unreachable', detail: 'token endpoint response missing token field' };
      }

      // 2) Confirm bearer is good for this specific repo on the manifest API.
      const manifestUrl = `${trimTrailingSlash(config.manifestBase)}/v2/${repoPath}/manifests/${PROBE_REFERENCE}`;
      let manifestStatus: number;
      try {
        const resp = await axios.request({
          url: manifestUrl,
          method: 'HEAD',
          headers: { Authorization: `Bearer ${bearer}` },
          timeout: timeoutMs,
          validateStatus: (s) => s >= 200 && s < 500,
        });
        manifestStatus = resp.status;
      } catch (err) {
        return { ok: false, reason: 'unreachable', detail: describeAxiosError(err) };
      }

      if (manifestStatus === 401 || manifestStatus === 403) {
        return { ok: false, reason: 'unauthorized', detail: `manifest HEAD returned ${manifestStatus}` };
      }
      // 200, 202, 404 all indicate the bearer was accepted; 404 just means
      // the "latest" tag is not present, which is fine.
      if (manifestStatus === 200 || manifestStatus === 202 || manifestStatus === 404) {
        return { ok: true, upstreamBearer: bearer };
      }
      return { ok: false, reason: 'unreachable', detail: `manifest HEAD returned ${manifestStatus}` };
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
