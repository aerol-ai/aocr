// Translate a mirror-side repo path (the "name" segment of the
// Distribution token-server scope the Docker client requested against the
// mirror vhost) into the upstream host + upstream-side repo path.
//
// The mirror's URL scheme (see MIRROR.md "Day-1 upstreams"):
//   library/<repo>             → docker.io,        library/<repo>
//   <user>/<repo>              → docker.io,        <user>/<repo>
//   aocr/ghcr/<org>/<repo>     → ghcr.io,          <org>/<repo>
//   aocr/gcr/<proj>/<repo>     → gcr.io,           <proj>/<repo>
//   aocr/quay/<org>/<repo>     → quay.io,          <org>/<repo>
//   aocr/k8s/<repo>            → registry.k8s.io,  <repo>
//
// `aocr` is the reserved disambiguator segment. Earlier drafts used `_`
// (Distribution v2 reserved-namespace convention) but Docker's reference
// grammar (distribution/reference) rejects `_` as a component, so the
// daemon errored out with "invalid reference format" before requests
// reached the mirror.
//
// The wrap envelope carries `creds.upstreamHost` independently (sandboxd
// knows which upstream the user's creds are for). The auth service
// cross-checks the host derived from the scope against the envelope's
// `upstreamHost` — a mismatch means either the client requested a path
// that disagrees with the wrapped creds, or someone is replaying a blob
// against a different upstream. Either way: reject.

export type UpstreamRoute = {
  host: string;
  upstreamRepo: string;
};

const PREFIX_TABLE: Array<{ prefix: string; host: string }> = [
  { prefix: 'aocr/ghcr/', host: 'ghcr.io' },
  { prefix: 'aocr/gcr/', host: 'gcr.io' },
  { prefix: 'aocr/quay/', host: 'quay.io' },
  { prefix: 'aocr/k8s/', host: 'registry.k8s.io' },
];

export function routeMirrorRepoToUpstream(mirrorRepo: string): UpstreamRoute | null {
  if (!mirrorRepo) return null;

  for (const { prefix, host } of PREFIX_TABLE) {
    if (mirrorRepo.startsWith(prefix)) {
      const upstreamRepo = mirrorRepo.slice(prefix.length);
      if (!upstreamRepo) return null;
      return { host, upstreamRepo };
    }
  }

  // No `aocr/<short>/` prefix → assume Docker Hub. DockerHub's two shapes:
  //   `library/<repo>` (single-segment shortcuts: redis, nginx, etc.)
  //   `<user>/<repo>`  (user/org namespace)
  // Both pass straight through to the upstream.
  if (mirrorRepo === 'aocr' || mirrorRepo.startsWith('aocr/')) {
    // `aocr/something-else/...` is reserved-but-unknown — reject rather
    // than letting it leak to docker.io.
    return null;
  }
  return { host: 'docker.io', upstreamRepo: mirrorRepo };
}

// True when the host derived from the mirror-side scope is consistent with
// the wrap envelope's `upstreamHost`. Case-insensitive on host comparison.
export function routeMatchesWrappedHost(route: UpstreamRoute, envelopeHost: string): boolean {
  return route.host.toLowerCase() === envelopeHost.toLowerCase();
}
