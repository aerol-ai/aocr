// Pure, testable core of F17's `validateUsingWrappedUpstream` strategy.
// server.ts wires this up with env-derived dependencies (key ring + proof
// cache); this module knows nothing about Express, Postgres, or process.env.

import { parseRequestedScopes } from '../scope';
import { credIdentity, unwrap, WrapError, WrapKeyRing } from './wrap';
import { ProofCache } from './proofCache';
import { getProbeForHost, UpstreamProbe } from './index';
import { routeMatchesWrappedHost, routeMirrorRepoToUpstream } from './route';

// Tokens minted from a wrapped proof are short. The proof underneath has a
// 5-minute TTL (proof cache default); the JWT TTL is 15 minutes so a Docker
// client can finish a multi-layer pull on a single handshake but the token
// does not far outlive the user's actual authorization.
export const WRAPPED_UPSTREAM_TOKEN_TTL_SECONDS = 15 * 60;
// Wrapped blobs older than this are rejected as replays. The wrap envelope
// embeds the timestamp so this check is server-side stateless.
export const WRAPPED_UPSTREAM_MAX_AGE_MS = 10 * 60 * 1000;
// Sandboxd produces strings of the form `aocrwrap:<base64url-blob>`. The
// auth service dispatches on this prefix before any PAT or API fallback.
export const WRAPPED_UPSTREAM_TOKEN_PREFIX = 'aocrwrap:';

export class WrappedUpstreamError extends Error {
  constructor(
    message: string,
    public code:
      | 'not_configured'
      | 'invalid_blob'
      | 'expired'
      | 'unauthorized'
      | 'unreachable'
      | 'unsupported'
      | 'route_mismatch',
  ) {
    super(message);
    this.name = 'WrappedUpstreamError';
  }
}

export type WrappedUpstreamSuccess = {
  // sha256 hex from credIdentity(creds). Caller uses this as the JWT
  // subject prefix and for log correlation; full cleartext creds never
  // leave this module.
  identity: string;
  // True when the proof cache satisfied the request without re-probing
  // upstream. Exposed for metrics / debugging.
  cacheHit: boolean;
};

export function isWrappedUpstreamToken(token: string): boolean {
  return token.startsWith(WRAPPED_UPSTREAM_TOKEN_PREFIX);
}

// The wrap envelope embeds the upstream `scope` (the Distribution token-
// server scope the client requested). PR 4b accepts any scope shape and
// hands each scope's "name" segment straight to the probe; PR 4c-adapter
// land will tighten this with per-upstream parsing rules. `scope` may be a
// repeated query param, so this returns every distinct name, first-seen order.
export function extractReposFromScope(scope: unknown): string[] {
  return Array.from(new Set(parseRequestedScopes(scope).map((entry) => entry.name)));
}

export type WrappedUpstreamDeps = {
  keyRing: WrapKeyRing;
  proofCache: ProofCache;
  now?: () => number;
  // Injectable probe resolver — defaults to the registry in index.ts. Tests
  // pass a stub.
  resolveProbe?: (host: string) => UpstreamProbe;
};

export async function validateWrappedUpstream(
  presentedToken: string,
  scope: unknown,
  deps: WrappedUpstreamDeps,
): Promise<WrappedUpstreamSuccess> {
  if (deps.keyRing.keys.length === 0) {
    throw new WrappedUpstreamError(
      'wrapped-upstream auth is not configured (no wrap keys)',
      'not_configured',
    );
  }
  if (!isWrappedUpstreamToken(presentedToken)) {
    throw new WrappedUpstreamError(
      'presented token is not a wrapped-upstream blob',
      'invalid_blob',
    );
  }
  const blob = presentedToken.slice(WRAPPED_UPSTREAM_TOKEN_PREFIX.length);

  let unwrapped;
  try {
    unwrapped = unwrap(deps.keyRing, blob);
  } catch (err) {
    if (err instanceof WrapError) {
      throw new WrappedUpstreamError(`wrap error: ${err.code}`, 'invalid_blob');
    }
    throw err;
  }

  const nowMs = (deps.now ?? Date.now)();
  const ageMs = nowMs - unwrapped.wrappedAt.getTime();
  if (ageMs > WRAPPED_UPSTREAM_MAX_AGE_MS) {
    throw new WrappedUpstreamError(
      `blob too old (${ageMs}ms > ${WRAPPED_UPSTREAM_MAX_AGE_MS}ms)`,
      'expired',
    );
  }

  const creds = unwrapped.creds;
  const identity = credIdentity(creds);

  // Route each mirror-side scope to an upstream host + upstream-side repo
  // path. Reject if a scope's prefix is unknown (would otherwise leak
  // arbitrary paths to docker.io) or if it disagrees with the wrap
  // envelope's `upstreamHost` (a replay attempt against a different
  // upstream, or a client bug). Every requested repo lands in the minted
  // JWT's access list, so every one must route and carry a proof — checking
  // only the first would let a second scope ride along unverified. All
  // routes are checked before any probe so a bad scope costs no round trip.
  const mirrorRepos = extractReposFromScope(scope);
  if (mirrorRepos.length === 0) {
    throw new WrappedUpstreamError('scope missing repository name', 'route_mismatch');
  }
  const routes = mirrorRepos.map((mirrorRepo) => {
    const route = routeMirrorRepoToUpstream(mirrorRepo);
    if (!route) {
      throw new WrappedUpstreamError(
        `unsupported mirror scope: ${mirrorRepo}`,
        'route_mismatch',
      );
    }
    if (!routeMatchesWrappedHost(route, creds.upstreamHost)) {
      throw new WrappedUpstreamError(
        `scope routes to ${route.host} but envelope says ${creds.upstreamHost}`,
        'route_mismatch',
      );
    }
    return route;
  });

  let cacheHit = true;
  for (const route of routes) {
    // Fast path: cached proof covers this exact identity + upstream repo.
    if (deps.proofCache.get(identity, route.upstreamRepo)) {
      continue;
    }

    // Slow path: probe the upstream.
    cacheHit = false;
    const probe = (deps.resolveProbe ?? getProbeForHost)(route.host);
    const result = await probe.probe(creds, route.upstreamRepo);
    if (result.ok === false) {
      if (result.reason === 'unauthorized') {
        // Drop any stale proof so the next try has to re-probe.
        deps.proofCache.invalidate(identity);
      }
      throw new WrappedUpstreamError(
        `probe failed: ${result.reason}${result.detail ? `: ${result.detail}` : ''}`,
        result.reason,
      );
    }
    deps.proofCache.record(identity, route.upstreamRepo, result.upstreamBearer);
  }
  return { identity, cacheHit };
}
