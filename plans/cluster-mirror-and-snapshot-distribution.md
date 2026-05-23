# AOCR Cluster Mirror + Snapshot Distribution

Status: draft (third revision — supersedes earlier `aocr-pull-through-cache.md`
notes in the AerolVM repo)
Owner: aocr + aerolvm
Last updated: 2026-05-23

## Why this exists

AerolVM is a multi-node Docker-backed sandbox platform. Today two things hurt
on a multi-node cluster:

1.  **External base images** (`redis:7-bookworm`, `python:3.12-slim`, etc.)
    are pulled per-node from DockerHub. Hit `node-1`, you wait. Hit `node-2`
    with the same image two seconds later, you wait again. DockerHub is also a
    rate-limit / availability dependency for every cold boot on every node.
2.  **Sandbox snapshots** committed on `node-1` are not available on `node-2`.
    AerolVM works around this by forcing every snapshot's image-distribution
    mode to `local_only`, which pins the sandbox (and any `recreate`
    failover) to its origin node forever. Origin-node loss = snapshot loss.

AOCR already runs in the cluster, already stores layers in S3, already has a
reaper that knows about TTL and idle retention. The cleanest fix is to make
AOCR do both jobs:

-   Be a **pull-through mirror** for upstream public registries, so the cluster
    only fetches each external base image once and reuses it from S3 forever.
-   Be the **canonical home for sandbox snapshots**, so AerolVM stops treating
    snapshots as node-local artifacts and instead pushes them to AOCR like any
    other image.

Both jobs share one S3 bucket and one Postgres metadata store. The reaper
already knows how to expire things by TTL or idle; we extend it slightly to
respect provenance.

The end-user-visible promise:

-   **First** pull of `redis:7-bookworm` on the whole cluster: AOCR proxies
    DockerHub, streams the layers into S3, and serves them to the requesting
    Docker daemon. ~normal pull latency.
-   **Every subsequent** pull of `redis:7-bookworm` on any node: served from
    S3 over the cluster LAN. No DockerHub round-trip, no rate limit, sub-second
    manifest.
-   **Snapshot pushed on `node-1`**: lands in AOCR. `node-2` can pull it
    immediately. `failover.policy: recreate` no longer has to be rejected for
    snapshot images.

## Design summary

One AOCR Go process, two TLS vhosts, one backend:

```
                                                 ┌─────────────────┐
                                          push +  │ aocr.aerol.ai   │   /v2/<org>/<image>
                          ┌──────────────► pull   │  (existing)     │   /v2/cluster/<org>/<snap>
                          │                       └────────┬────────┘
   docker push / pull ────┤                                │
   (AerolVM sandboxd      │                                │ shared
    + end users)          │                                │ S3 bucket + Postgres
                          │                       ┌────────┴────────┐
                          └──────────────► pull   │ mirror.aerol.ai │   /v2/library/<image>
                                          only    │  (new vhost)    │   /v2/<image>
                                                  │  proxy mode     │   (DockerHub, ghcr,
                                                  └─────────────────┘    gcr, quay, k8s.gcr)
```

Backed by the same Distribution v2 binary running with two `http:` listeners,
each pointing to its own `auth:` block. The push vhost behaves as today
(token auth via AOCR auth service). The mirror vhost is anonymous-readable
inside the cluster network and uses a custom proxy handler that streams from
upstream public registries on a miss and persists into the shared S3 bucket.

Because both vhosts write to the same blob storage and the same Postgres
catalog, sandbox snapshots and proxied base images naturally **share layers**
via Distribution's mount-from-repo API — the cluster keeps exactly one
physical copy of each layer.

## Features being built

### F1. Pull-through mirror vhost on AOCR
Anonymous-readable, intra-cluster-only HTTP vhost that proxies DockerHub,
ghcr.io, gcr.io, quay.io, and registry.k8s.io. On cache miss, fetches from
upstream, stores blob and manifest in the shared S3 bucket, returns to caller.
Cache hits do not hit upstream at all.

### F2. Provenance-aware reaper
The reaper learns the difference between `cluster-pushed` images (snapshots,
user pushes) and `mirror-cached` images (proxied from upstream). They expire
on different policies — snapshots follow user-supplied retention tags; mirror
entries follow an idle-eviction policy with a deployment-wide default
(`mirror.defaultIdle: 30d`).

### F3. Cluster-identity PAT class
A new class of PAT scoped to push only into a single cluster-owned
organization (`cluster/<cluster_id>/...`). AerolVM sandboxd's machine identity
gets one of these; it can push snapshots but cannot push into a user's org or
read another cluster's snapshots.

### F4. Snapshot push-on-commit (AerolVM side)
When `docker.CreateSnapshot` succeeds, AerolVM tags the new image as
`aocr.aerol.ai/cluster/<cluster_id>/<snapshot_id>:<rev>--idle-<N>d` and pushes
it. The snapshot's `image.distribution.mode` is set to `aocr` instead of
`local_only`. On failure to push, AerolVM falls back to `local_only` so the
snapshot still works on its origin node — best-effort behavior, never blocks
the user's commit.

### F5. Daemon mirror configuration (AerolVM side, DockerHub only)
The sandboxd installer (Ansible + `scripts/install.sh`) writes
`/etc/docker/daemon.json` with `registry-mirrors: ["https://mirror.aocr.aerol.ai"]`
so every `docker pull` of a DockerHub image goes through AOCR transparently.
This **only** covers DockerHub — Docker's `registry-mirrors` config does not
rewrite pulls for ghcr.io, gcr.io, quay.io, or registry.k8s.io. Coverage for
those upstreams is F5b.

### F5b. Sandboxd-side image ref rewriter (all non-DockerHub upstreams)
Because Docker's daemon `registry-mirrors` is DockerHub-only, sandboxd
rewrites image references before they reach the Docker pull API. A new
`rewriteImageRefForMirror(ref)` helper sits in front of `pkg/docker/client.go`'s
pull path:

-   `ghcr.io/aerol-ai/foo:tag`        → `mirror.aocr.aerol.ai/_/ghcr/aerol-ai/foo:tag`
-   `gcr.io/proj/foo:tag`             → `mirror.aocr.aerol.ai/_/gcr/proj/foo:tag`
-   `quay.io/org/foo:tag`             → `mirror.aocr.aerol.ai/_/quay/org/foo:tag`
-   `registry.k8s.io/coredns/coredns` → `mirror.aocr.aerol.ai/_/k8s/coredns/coredns`
-   `docker.io/...` and bare names    → unchanged (handled by F5 daemon config)
-   `aocr.aerol.ai/...`               → unchanged (push vhost, not mirrored)
-   `mirror.aocr.aerol.ai/...`        → unchanged (already rewritten)
-   any host not in the upstream map  → unchanged (pulled direct)

The end user keeps writing `client.create({ image: "ghcr.io/aerol-ai/foo" })`;
sandboxd silently routes the pull through the mirror. The rewrite is gated by
`AOCR_MIRROR_HOST` being set and the upstream being present in
`AOCR_MIRROR_UPSTREAMS` (mirrors AOCR's `mirror.upstreams` map). The original
ref is preserved in the sandbox row for display so the user-facing image
field never shows the mirror URL.

When `registryAuth` is set on the create request, the rewrite **still
happens** — authenticated pulls go through the mirror via the delegated-auth
flow (F17). See "Authenticated images" section below.

### F6. Per-namespace upstream config
The mirror vhost reads an upstream map from config:
```yaml
mirror:
  upstreams:
    docker.io:        { backend: "registry-1.docker.io", path: "" }
    ghcr.io:          { backend: "ghcr.io",              path: "" }
    gcr.io:           { backend: "gcr.io",               path: "" }
    quay.io:          { backend: "quay.io",              path: "" }
    registry.k8s.io:  { backend: "registry.k8s.io",      path: "" }
```
Path mapping: `/v2/library/<x>/...` → DockerHub library; `/v2/<ns>/<x>/...`
→ DockerHub user namespace; `/v2/_/ghcr/<org>/<image>/...` → ghcr; etc.

### F7. Anonymous read + cluster-network ACL on mirror vhost
The mirror is anonymous-readable but its ingress rule only accepts traffic
from cluster CIDRs (or, in cloud deployments, from the AerolVM node
SecurityGroup). It is not exposed to the public Internet.

### F8. Optional blob-presence query API
New endpoint `GET /v1/internal/blobs/<digest>` returning `{present: bool}`
so AerolVM can short-circuit decisions like "do I really need to pull this
locally, or is it already in S3?". Used by F10 (image-locality affinity
hints) and by diagnostic tooling.

### F9. Cluster-scoped snapshot lifecycle API
New `/v1/internal/snapshots` endpoints to let AerolVM register a snapshot
with structured metadata (cluster_id, owner sandbox id, parent image digest,
size hint) at push time. Lets the reaper apply cluster-policy retention
(e.g., "evict snapshots whose origin sandbox no longer exists") in addition
to tag-suffix retention.

### F10. Image-locality placement affinity (AerolVM side, deferred)
SWIM heartbeats already carry capacity; we add a small "top-K LRU image
digests present locally" set. The placement scorer adds a +0.15 bonus to
candidates that already have the requested image's manifest digest cached.
First-pull cost drops to one node; subsequent pulls of the same image bias
toward warm nodes without forcing locality.

### F11. Snapshot recreate-on-failover unlock
Once snapshots are AOCR-resident, `failover.policy: recreate` is no longer
rejected for snapshot images. The owner-watcher and dead-owner reconciliation
paths in `internal/cluster/` stop short-circuiting on
`ImageDistributionLocalOnly` for snapshot-origin images.

### F12. Snapshot fallback to local_only
If push to AOCR fails (network glitch, AOCR down, auth expired) the snapshot
is still committed locally and marked `local_only` exactly as today. The
push is retried asynchronously. The user's `client.snapshot()` call never
fails because of a transient AOCR issue.

### F13. Mirror cache observability
Per-upstream cache-hit, cache-miss, bytes-served, bytes-pulled-from-upstream
metrics on the mirror vhost. Surfaced in the existing AOCR Grafana dashboard.

### F14. Mirror cache eviction policy
Reaper learns `provenance = 'mirror'` and respects
`mirror.defaultIdle` (default 30d). Operators can override per upstream:
```yaml
mirror:
  retention:
    docker.io: 90d
    registry.k8s.io: 365d
```

### F15. AerolVM-side image-distribution mode flip
`internal/service/image_distribution.go`'s `normalizeSnapshotImageDistribution`
stops force-flipping to `local_only`; it now picks `aocr` when push-on-commit
succeeded and `local_only` otherwise. `ImageRequiresLocalPlacement` only
returns true for the actual local-only outcome.

### F16. Documentation
New `MIRROR.md` in aocr explaining the two-vhost deployment, upstream map,
how the mirror differs from a transparent proxy, and what it does NOT do
(no detection-evasion of upstream rate limits — if upstream rate-limits us,
we surface the rate-limit). Update `README.md` with the new vhost. Update
AerolVM's docs to remove the "snapshots are node-local" caveat. Add
`AUTHENTICATED_MIRROR.md` covering the delegated-auth flow (F17–F20),
operator setup, key rotation, and the supported upstream auth protocols.

## Authenticated images (delegated upstream auth)

The mirror must work for private images — the majority case for production
users. The design is delegated auth: AOCR uses the user's upstream creds
once per proof window to prove access, then mints a scoped AOCR JWT that
gates cache reads. AOCR does not store user creds long-term and does not
share cache entries across users without each user independently proving
access to the referenced manifest.

### F17. Wrapped-credential proxy auth

Sandboxd wraps the user-supplied `RegistryAuth` into an opaque AEAD-encrypted
blob using a cluster-wide key shared with AOCR. The blob carries
`{upstream_host, username, password_or_token, scope}`. Sandboxd substitutes
this blob for the cleartext creds when building the `X-Registry-Auth` header
it passes to the Docker daemon (using the `identitytoken` field that the
Docker daemon will forward verbatim to the registry it's pulling from).

AOCR's auth service gains a new validation strategy
`validateUsingWrappedUpstream` (alongside the existing static-PAT and API
strategies). On receiving `/v2/token` with a wrapped blob:

1.  Decrypt with the cluster wrap key.
2.  Reject if blob age exceeds 10 minutes (replay defense — the wrapper
    includes a timestamp inside the AEAD).
3.  Perform the upstream-specific auth flow (F20) against the upstream host.
4.  HEAD the upstream manifest for the requested scope's repo to confirm
    THIS user can read THIS specific repo, not just "creds are valid
    somewhere."
5.  Mint an AOCR-signed JWT scoped to `repository:_/<short>/<org>/<repo>:pull`,
    TTL 15 minutes.
6.  Forget the upstream creds. Cache only the proof outcome (F18).

The mirror vhost validates the AOCR JWT exactly like any other request. On
cache miss for a blob or manifest under the scoped path, the mirror needs
upstream credentials again — it asks the auth service for a short-lived
"fetch session" tied to the same proof (the proof cache holds the upstream
bearer for the proof window). If the proof has aged out, the mirror returns
401 and Docker daemon re-runs the /v2/token handshake transparently.

### F18. Proof-of-access cache

In-memory LRU cache inside the auth service:
`key = sha256(upstream_host || username || password)`,
`value = { proven_at, expires_at, upstream_bearer, scoped_repos: Set<string> }`.

-   Default proof TTL: **5 minutes**.
-   Default size: 10,000 entries (~few MB).
-   Eviction: LRU when size bound hit; explicit invalidation on upstream 401.
-   `upstream_bearer` is the upstream registry token AOCR received during
    proof; reused for mirror-side fetches within the proof window. Held
    in-process memory only, never persisted, zeroed on eviction.

The proof cache exists to avoid hammering ghcr's token endpoint on every
single layer pull of a 200-layer image. Without it, a single sandbox boot
might do 200+ upstream handshakes; with it, one.

### F19. Cluster wrapping key

New required secret: 32 bytes of high-entropy randomness used as the
AES-GCM-256 key for F17's credential wrapping.

-   AOCR side: `auth.upstreamAuth.wrapKey` in Helm values (sourced from a
    Kubernetes Secret in production). Mounted into the auth service as
    `UPSTREAM_AUTH_WRAP_KEY` env.
-   AerolVM side: same 32 bytes deployed to every sandboxd node via Ansible
    role, written to `/etc/aerolvm/upstream-wrap.key` (mode 0400, owned by
    sandboxd user).
-   Rotation: Ansible playbook `rotate-upstream-wrap-key.yml`. Auth service
    accepts both the current and the previous key for a configurable overlap
    window (default 24h) to allow zero-downtime rotation. Both keys are
    listed in `UPSTREAM_AUTH_WRAP_KEYS` as a comma-separated list; sandboxd
    always wraps with the first (newest); auth service tries each in turn
    when decrypting.

If the wrap key is missing on the AOCR side, F17 is disabled and
authenticated pulls fail closed with a clear error message — they do not
silently fall back to direct pulls.

### F20. Per-upstream auth-flow adapters

A small Go interface in the mirror code with one implementation per upstream:

```go
type UpstreamAuthFlow interface {
    // Probe verifies the creds can read the named repo on upstream.
    // Returns an opaque bearer the mirror can reuse for blob/manifest fetches.
    Probe(ctx context.Context, creds UpstreamCreds, repo string) (bearer string, err error)
}
```

Adapters in v1:

-   **DockerHub.** Token exchange against `auth.docker.io/token`, scope
    `repository:<user>/<image>:pull`.
-   **ghcr.io.** Token exchange against `ghcr.io/token`, scope similar.
-   **quay.io.** Token exchange against `quay.io/v2/auth`.
-   **gcr.io.** Service-account JSON → OAuth2 access token →
    `gcr.io/v2/token` exchange.
-   **registry.k8s.io.** Anonymous; no adapter needed (probes via plain HEAD).

**ECR is explicitly deferred to a later phase** (separate from this plan).
ECR uses AWS SigV4 + `GetAuthorizationToken` and would pull the AWS SDK
into the auth service. When added, ECR creds come in as
`{accessKeyId, secretAccessKey, region, optional sessionToken}` and the
adapter handles the auth-token fetch + 12h refresh internally.

### Snapshot of a privately-pulled base

When a user creates a sandbox from `ghcr.io/private/foo` and snapshots it,
the snapshot is pushed by sandboxd's cluster-class PAT (F3+F4) into
`cluster/<cluster_id>/<snap>`. Pulling that snapshot on another node uses
the cluster PAT, not the user's upstream creds — the cluster has effectively
"absorbed" the private base into its own snapshot namespace. This is correct:
the user already proved access to the base bytes at creation time and chose
to commit them into a snapshot they own. Cross-cluster isolation still holds
(cluster B cannot read cluster A's snapshots; F3).

## Use cases

These are the behaviors the implementation must satisfy. Each one is a check
that survives implementation choices. Cases 21–22 cover non-DockerHub upstreams
via F5b.

1.  **Cold-cluster first pull of redis:7-bookworm.** A brand-new cluster
    receives a sandbox create with `image: redis:7-bookworm`. The chosen node's
    Docker daemon hits `mirror.aocr.aerol.ai`, AOCR proxies DockerHub, stores
    layers in S3, serves the pull. Latency ≈ DockerHub latency. Subsequent
    pulls on any node skip DockerHub entirely.

2.  **Second-pull on a different node.** Five seconds after use case 1, a
    sandbox with the same image lands on a different node. That node's Docker
    daemon hits the mirror; AOCR returns the manifest and layers from S3.
    DockerHub is not contacted. Cache-hit metric increments by N (one per
    layer + one per manifest).

3.  **DockerHub rate limit hits AOCR, not the cluster.** DockerHub returns
    429 to AOCR. AOCR surfaces the 429 to the requesting Docker daemon for
    that specific image. Other images already in cache continue to serve.
    The cluster does not get rate-limited because every node was reusing one
    egress IP.

4.  **DockerHub is completely down.** All cached images continue to pull
    successfully from AOCR. Only images that were never pulled before fail.
    Reported clearly in mirror metrics (`upstream_error_total`).

5.  **Snapshot pushed on `node-1`, consumed on `node-2`.** User calls
    `client.snapshot()` on a sandbox running on node-1. AOCR ingests the
    snapshot manifest+layers. User then calls `client.create({ snapshot: id })`
    and placement picks node-2. node-2's Docker pulls from
    `aocr.aerol.ai/cluster/<id>/<snap>:<rev>--idle-30d` and starts the
    sandbox. No `local_only` pin.

6.  **Snapshot push fails; user still gets a usable snapshot.** AOCR is
    temporarily unreachable when `CreateSnapshot` runs. The snapshot is still
    committed locally on node-1, marked `local_only`, and works there. A
    background retry re-pushes when AOCR comes back, after which the snapshot
    is flipped to `aocr`.

7.  **Snapshot of a snapshot.** User creates sandbox from snapshot A
    (AOCR-resident), modifies it, snapshots it as B. B's parent layers are
    already in S3, so the push only uploads the new top layer. Verified via
    Distribution's blob-mount API returning 201 without a layer body.

8.  **Layer dedup between proxied image and snapshot.** A snapshot of a
    sandbox originally booted from `redis:7-bookworm` shares the redis
    base-layer blobs with the proxied `redis:7-bookworm`. One physical S3
    object per blob, regardless of how many snapshots or proxied images
    reference it.

9.  **Image-distribution mode promoted on push success.** After a successful
    snapshot push, the AerolVM store row for that snapshot has
    `image.distribution.mode = "aocr"` and a stable `RegistryRef`. The
    `local_only` placement constraint is lifted.

10. **`failover.policy: recreate` now accepted for a snapshot.** A sandbox
    based on an AOCR-resident snapshot is created with
    `failover.policy: recreate`. The validation that previously rejected this
    (because snapshots were local-only) accepts it. If the origin node dies,
    the dead-owner reconciliation recreates the sandbox on another node by
    pulling the snapshot from AOCR.

11. **Per-cluster isolation of pushed snapshots.** Cluster A's sandboxd PAT
    can push to `cluster/A/...` and read from `cluster/A/...` and from any
    `mirror.*` namespace. It cannot push to `cluster/B/...` or read from
    `cluster/B/...`. Enforced in the auth service via the PAT class and
    scope check.

12. **Idle eviction of a stale snapshot.** A snapshot pushed with
    `--idle-30d` is not pulled for 31 days. The reaper deletes the manifest
    and metadata. Garbage collection (existing CronJob) eventually reclaims
    the blob storage. AerolVM's store entry for the snapshot is marked
    missing on next reconcile.

13. **Idle eviction of a stale mirrored image.** No node has pulled
    `mongo:6` from the mirror for 31 days. Mirror reaper (F14) deletes the
    manifest. Next pull becomes a cold miss and re-fetches from upstream.

14. **Snapshot recently pulled is preserved.** A snapshot with `--idle-30d`
    is pulled on day 29. `last_pulled_at` is updated by the existing pull
    hook. The 30-day clock resets. Reaper does not evict it.

15. **Direct `docker push` by an end user is unaffected.** The hosted-user
    path (`aocr.aerol.ai/aocr/<user-image>`) keeps working exactly as today.
    User auth, retention, reaper, and ingress for that namespace are
    unchanged. The mirror vhost and the cluster snapshot namespace are
    additions, not rewrites.

16. **Mirror is reachable only from inside the cluster.** A request to
    `mirror.aocr.aerol.ai` from outside the cluster CIDR (or cloud security
    group) is rejected at ingress. An internal request from a sandboxd node
    succeeds. Verified by smoke test in the Ansible playbook.

17. **AOCR knows whether a blob is already present.** AerolVM calls
    `GET /v1/internal/blobs/sha256:...`; AOCR consults S3 head; returns
    `{present: true}` or `{present: false}`. Used by image-locality
    affinity hints (F10) without requiring AerolVM to talk to S3 directly.

18. **Two snapshots pushed concurrently from the same node.** Two parallel
    `CreateSnapshot` calls land. They serialize through AerolVM's existing
    `snapshotMu` and then push sequentially. The hooks pipeline records two
    separate `push` events and stores both rows. The reaper's "keep one
    latest plain tag" rule does not apply because they use distinct retention
    suffixes.

19. **Mirror upstream returns a manifest list (multi-arch).** AOCR caches the
    manifest list verbatim and resolves the per-arch manifest on demand,
    caching that too. A node pulling `linux/arm64` and a node pulling
    `linux/amd64` each get their own arch-specific layers; both share the
    manifest list. Verified end-to-end with a known multi-arch image.

20. **Auth: cluster-class PAT cannot serve as a user PAT.** Attempting to
    `docker login` from outside the cluster using the cluster-class PAT and
    pushing into a non-`cluster/<id>` namespace is rejected by the auth
    service with 401. Conversely, the cluster-class PAT can authenticate
    against the push vhost only for its own org. Round-trip verified.

21. **Non-DockerHub upstream is transparently mirrored (F5b).** User calls
    `client.create({ image: "ghcr.io/aerol-ai/foo:v3" })`. Sandboxd rewrites
    the ref to `mirror.aocr.aerol.ai/_/ghcr/aerol-ai/foo:v3` before invoking
    Docker's pull API. The mirror serves from cache or fetches from ghcr on
    miss. The sandbox row's `image` field still displays the original
    `ghcr.io/...` ref. Cache-hit/miss metrics for the `ghcr` upstream
    increment. Repeat on a second node hits the S3 cache, not ghcr.

22. **User-supplied unknown registry bypasses the mirror unchanged.** User
    calls `client.create({ image: "some-internal-registry.example.com/app:1.0" })`
    where the host is not in `AOCR_MIRROR_UPSTREAMS`. Sandboxd leaves the
    ref untouched and pulls direct. No mirror lookup, no failure. Lets users
    point at private registries the cluster has no opinion about.

23. **Authenticated pull of a private ghcr image (F17).** User calls
    `client.create({ image: "ghcr.io/private-org/foo:v1", registryAuth: {...} })`.
    Sandboxd wraps the creds with the cluster wrap key, rewrites the ref to
    `mirror.aocr.aerol.ai/_/ghcr/private-org/foo:v1`, and passes the wrapped
    blob as `identitytoken` in `X-Registry-Auth`. AOCR auth service decrypts,
    performs ghcr token exchange + manifest HEAD, mints a scoped JWT, and the
    mirror serves from cache or fetches authenticated. Repeat-pull on a
    second node by the same user reuses the S3 cache; each pull still
    re-validates a scoped JWT.

24. **Two different users with independent access to the same private repo
    share the cache.** Alice and Bob both have legitimate access to
    `ghcr.io/private-org/foo:v1`. Alice pulls; blobs land in S3. Bob pulls
    seconds later with his own creds. Bob's wrapped blob proves independently
    against ghcr; AOCR mints Bob a separate scoped JWT; mirror serves from
    Alice's cached blobs. Upstream sees two token-exchanges (cheap), one
    manifest HEAD per user, zero blob downloads for Bob.

25. **User without access to the private repo is blocked even if blobs are
    cached.** Eve has valid ghcr creds for a different org but not for
    `private-org`. Eve attempts the same pull. AOCR auth service's manifest
    probe against ghcr returns 401. AOCR returns 401 to Eve's Docker daemon.
    The blobs in S3 are unreachable to Eve because she cannot obtain a
    scoped JWT for `_/ghcr/private-org/foo`.

26. **Upstream credentials revoked mid-session.** Alice's ghcr PAT is
    revoked. Her cached scoped JWT continues to work for up to 15 minutes
    (its TTL). After expiry, her next /v2/token attempt fails the upstream
    probe; AOCR invalidates her proof cache entry; she's locked out. Other
    users with valid creds for the same repo are unaffected.

27. **Wrong credentials surface cleanly.** User passes the wrong password.
    AOCR's upstream token exchange returns 401. AOCR's /v2/token endpoint
    returns 401 with a body explaining the upstream auth failed. Docker
    daemon surfaces a recognizable pull error. No partial state is cached.

28. **Snapshot of a sandbox booted from a private base image.** User runs a
    sandbox from `ghcr.io/private-org/foo:v1` (auth via F17) and snapshots
    it. The snapshot is pushed by sandboxd's cluster-class PAT to
    `cluster/<id>/<snap>:<rev>--idle-30d`. Pulling the snapshot on another
    node uses the cluster PAT and requires zero upstream auth — the base
    bytes were committed into a cluster-owned image at snapshot time.
    Cross-cluster isolation still applies (cluster B cannot read cluster A's
    snapshots, even though both might reference identical upstream blobs).

29. **Wrap key rotation with zero downtime.** Operator runs the
    `rotate-upstream-wrap-key.yml` Ansible playbook. New key is deployed to
    AOCR auth service first (auth accepts old AND new for the overlap
    window). New key is then deployed to all sandboxd nodes (they start
    wrapping with the new key). After the overlap window, old key is removed
    from auth. In-flight pulls never see an auth failure.

30. **Mirror auth fails closed when wrap key is missing.** AOCR is deployed
    without `auth.upstreamAuth.wrapKey` configured. An authenticated pull
    attempt returns a 503 with an error message identifying the
    misconfiguration. The pull does NOT silently fall back to direct
    upstream pull (which would defeat the cache and obscure the
    misconfiguration).

31. **Pull is concurrent across many layers; upstream is only contacted
    once per proof (F18).** A 200-layer image is pulled. Docker daemon
    fires concurrent blob GETs. The mirror's per-layer fetches all reuse
    the one cached upstream bearer for the proof window. Upstream sees one
    token exchange + one manifest HEAD + one blob GET per uncached layer.
    Proof cache hit ratio for this single pull is N-1 out of N requests.

## Files to modify, by repo

### AOCR (`/Users/sumansaurabh/Documents/startup-3/aocr.sh/`)

| File | What changes |
| :--- | :--- |
| `registry/config.yml` | Add second `http:` listener block bound to mirror port; mirror block sets `auth: { silly: { realm, service }}` (anonymous) instead of token auth. |
| `helm/aocr/files/registry-config.yml` | Same two-vhost shape. Templatized: mirror enabled only when `mirror.enabled: true`. |
| `helm/aocr/values.yaml` | New `mirror:` section: `enabled`, `host` (default `mirror.aerol.ai`), `port`, `upstreams` map, `retention` map, `defaultIdle`, `allowList` CIDRs. |
| `helm/aocr/templates/registry.yaml` | Expose the mirror port in the Service + Deployment when `mirror.enabled`. Add a separate Service `aocr-mirror` so ingress can route by host without coupling to the push Service. |
| `helm/aocr/templates/ingress.yaml` | New `host: mirror.<global.domain>` rule routing `/v2/...` to the mirror Service. CIDR allow-list annotation on the mirror host only (`traefik.ingress.kubernetes.io/whitelist-source-range` or class-equivalent). |
| `helm/aocr/templates/auth.yaml` | Auth service gains the cluster-class PAT envs and the `UPSTREAM_AUTH_WRAP_KEYS` env (sourced from a Kubernetes Secret listing current + previous keys during rotation). |
| `helm/aocr/templates/secrets.yaml` | New secret entry `upstream-wrap-keys` (comma-separated 32-byte hex keys). |
| `helm/aocr/values.yaml` (additions) | New `auth.upstreamAuth.enabled` bool, `auth.upstreamAuth.wrapKey` and `auth.upstreamAuth.previousWrapKey` (rotation), `auth.upstreamAuth.proofTtlSeconds: 300`, `auth.upstreamAuth.scopedJwtTtlSeconds: 900`. Per-upstream adapter enablement under `mirror.upstreams.<host>.authAdapter`. |
| `helm/aocr/templates/hooks.yaml` | Hooks gains `MIRROR_DEFAULT_IDLE_SECONDS` and `MIRROR_UPSTREAM_RETENTION_JSON` envs the reaper consumes. |
| `auth/src/server.ts` | New PAT class. JWT `access[]` is constrained for cluster-class PATs to `repository:cluster/<cluster_id>/*` + `repository:mirror/*` (read-only). Push to anything else returns 401. Also gains the `validateUsingWrappedUpstream` strategy for F17 — alongside `validateUsingStaticPat` / `validateUsingApi`. |
| `auth/src/upstreamAuth/wrap.ts` (new) | F17/F19. AES-GCM-256 wrap/unwrap of upstream creds. Supports a list of keys for rotation overlap (`UPSTREAM_AUTH_WRAP_KEYS`); tries each on decrypt; always uses first on encrypt. Includes a 10-min timestamp inside the AEAD for replay defense. |
| `auth/src/upstreamAuth/proofCache.ts` (new) | F18. In-memory LRU keyed by `sha256(host‖user‖password)`, value `{provenAt, expiresAt, upstreamBearer, scopedRepos}`. Bounded size, default 10k entries, default 5min TTL. Explicit invalidate on 401. |
| `auth/src/upstreamAuth/adapters/` (new dir) | F20. One file per upstream: `dockerHub.ts`, `ghcr.ts`, `quay.ts`, `gcr.ts`, plus `anonymous.ts` for k8s.gcr. Each exports `probe(creds, repo) → upstreamBearer`. Common test fixtures in `__tests__/`. |
| `auth/src/upstreamAuth/index.ts` (new) | Glue: dispatch from upstream-host to adapter, run probe, push outcome into proof cache, return result to caller in `server.ts`. |
| `auth/src/metrics.ts` | Counters for cluster-class PAT usage, wrapped-cred decrypt success/failure, proof-cache hit/miss/evict, per-upstream probe success/failure latency, scoped-JWT mint count. |
| `auth/src/__tests__/wrappedUpstream.test.ts` (new) | Round-trip wrap/unwrap, rotation overlap, expired-timestamp rejection, per-adapter probe stubs, proof-cache hit avoids second probe, 401 invalidates cache, scoped-JWT contains correct repo scope only. |
| `db/init.sql` | New columns on `images`: `provenance VARCHAR(32) NOT NULL DEFAULT 'pushed'` (values: `pushed`, `mirror`, `cluster-snapshot`), `upstream_ref TEXT NULL`, `cluster_id UUID NULL`, `source_sandbox_id TEXT NULL`. Backfill statement defaulting existing rows to `pushed`. Partial indexes for provenance-aware reaper queries. |
| `db/migrate-provenance.sql` (new) | Forward migration for an in-place upgrade of an existing deployment. |
| `hooks/src/controllers/HookAPI.ts` | On `push`, derive `provenance` from repository prefix: `cluster/...` → `cluster-snapshot`, `mirror/...` → `mirror`, else `pushed`. Store the extra columns. |
| `hooks/src/util/imageRetention.ts` | Reaper learns provenance: `pushed` keeps current rules; `cluster-snapshot` uses the tag-suffix policy already in place; `mirror` uses `last_pulled_at + mirror.upstreamIdle`. Indexes adjusted. |
| `hooks/src/util/tagRetention.ts` | No behavior change required for tag parsing; add an `inferredProvenance(repository)` helper used by HookAPI. |
| `hooks/src/controllers/MirrorBlobAPI.ts` (new) | `GET /v1/internal/blobs/:digest` (F8). Reads from Postgres + does S3 HEAD; returns presence. Cluster-internal only (token-checked against `INTERNAL_API_TOKEN`). |
| `hooks/src/controllers/SnapshotAPI.ts` (new) | `POST /v1/internal/snapshots`, `DELETE /v1/internal/snapshots/:id` (F9). Auth: cluster-class PAT or `INTERNAL_API_TOKEN`. |
| `hooks/src/server.ts` | Register new controllers. |
| `hooks/src/router.ts` | Route additions. |
| `registry/Dockerfile` | If we go with the in-process custom proxy (recommended), this needs to bake in the proxy module — see "Proxy implementation choice" below. Otherwise no change. |
| `deploy/grafana/aocr-observability-dashboard.json` | New panels: mirror cache hit ratio, mirror bytes-served, mirror upstream-error rate, cluster-snapshot push rate, provenance breakdown of stored blobs. |
| `OBSERVABILITY.md` | Document new metrics. |
| `RETENTION.md` | Document mirror retention + cluster-snapshot retention rules. |
| `README.md` | Document the two-vhost shape. |
| `MIRROR.md` (new) | Detailed mirror operator doc. |
| `SELF_HOSTING.md` | Add an "enable mirror" section. |
| `docker-compose.yaml` | Optional second listener for local-dev mirror. |
| `docker-compose.metrics.yaml` | Scrape the second port. |
| `ansible/` (existing AOCR ansible if any) | Mirror enablement role + cluster-class PAT provisioning. |

### Proxy implementation choice (call out in plan, decide before coding)

Distribution v2's built-in `proxy:` mode is read-only — a single binary
cannot both proxy and accept pushes. There are two viable shapes:

-   **A. Two Distribution processes, one binary, shared S3.** Run a second
    Distribution instance (`aocr-mirror`) in `proxy: { remoteurl: ...}` mode,
    pointed at the same S3 bucket. Simplest, smallest LOC. Limitation:
    Distribution's proxy block hardcodes a single upstream URL per process,
    so multi-upstream needs one Distribution process per upstream — i.e.,
    `mirror-docker`, `mirror-ghcr`, `mirror-gcr`, etc. Fine for 4–5
    upstreams; ugly past that.
-   **B. Custom Go proxy module in front of a stock Distribution.** A small
    Go reverse-proxy (~500 LOC) routes by path prefix, fetches from the
    right upstream on miss, writes blob + manifest into the shared S3 bucket
    via the existing Distribution HTTP API (so we reuse Distribution's
    blob-write idempotency and don't reimplement the storage layer).
    Lets us serve many upstreams from one vhost cleanly.

Recommendation: **B**, because it keeps the user-facing URL shape
(`/v2/library/redis`, `/v2/<ns>/<image>`, `/v2/_/ghcr/<org>/<image>`)
predictable across upstreams. The custom proxy lives in a new top-level
`mirror/` folder in aocr.

### AerolVM (`/Users/sumansaurabh/Documents/startup-3/sandbox-library/`)

| File | What changes |
| :--- | :--- |
| `internal/service/image_distribution.go` | Stop forcing `local_only` for snapshots. New `aocrPusher` interface and default implementation that tags and pushes via Docker daemon. `normalizeSnapshotImageDistribution` returns `aocr` on success, `local_only` on push failure (best-effort). |
| `internal/service/service.go` | `CreateSnapshotWithOwnership` calls the pusher after `docker.CreateSnapshot` succeeds. Push runs under existing `snapshotMu`. Push failure does not fail the user-facing call. |
| `internal/service/service.go` (validation) | Remove the line that rejects `failover.policy: recreate` for local-only images, replacing it with a check on the *resolved* distribution mode (so a snapshot that ends up `local_only` because push failed is still rejected — the constraint is correct, but it's no longer structural). |
| `pkg/docker/client.go` | New `PushImage(ctx, ref, RegistryAuth) error` mirroring the pattern of `pullImage`. Reuses the `X-Registry-Auth` header construction. |
| `pkg/docker/client.go` | New `TagImage(ctx, source, target) error` that issues `POST /images/<source>/tag?repo=<repo>&tag=<tag>`. |
| `pkg/docker/mirror_rewrite.go` (new) | F5b. `RewriteImageRefForMirror(ref, mirrorHost, upstreams) (rewritten, original string)`. Pure function, no I/O. Handles DockerHub passthrough, mirror/push-vhost passthrough, unknown-host passthrough, and the per-upstream `/_/<short>/...` mapping. |
| `pkg/docker/mirror_rewrite_test.go` (new) | Table-driven test for every host case in F5b, including idempotency (already-rewritten ref is left alone) and authenticated-path behavior (auth still goes through mirror, not skipped). |
| `pkg/docker/client.go` (pull path) | Call `RewriteImageRefForMirror` immediately before `pullImage`. Pass the rewritten ref to Docker; keep the original ref in returned metadata so the sandbox row's `image` field stays user-friendly. When `RegistryAuth` is set and the ref is being rewritten, wrap the auth via F17 (`WrapUpstreamCreds`) and substitute `identitytoken` in the `X-Registry-Auth` header. |
| `pkg/docker/upstream_wrap.go` (new) | F17 client side. `WrapUpstreamCreds(host, username, password) (identityToken string, err error)`: AES-GCM-256 encrypts `{host, username, password, issuedAt}` with the wrap key loaded from `/etc/aerolvm/upstream-wrap.key`. Returns the base64url-encoded blob to put in `X-Registry-Auth`. |
| `pkg/docker/upstream_wrap_test.go` (new) | Round-trip test against a fake AOCR unwrap routine; expired-timestamp rejection; clear error when key file missing. |
| `pkg/secrets/wrap_key_loader.go` (new) | Loads `/etc/aerolvm/upstream-wrap.key`, supports the same comma-separated rotation list as the AOCR side, exposes the active key. File mode check (0400) at load time; refuses to start if world-readable. |
| `internal/service/service.go` | When persisting a created sandbox, store both `image` (the user-supplied ref) and the rewritten pull-ref in trace/log fields only — the wire DTO continues to show the original ref. |
| `internal/config/config.go` | Add `AOCR_MIRROR_UPSTREAMS` (comma-separated `host=shortname` pairs, e.g. `ghcr.io=ghcr,gcr.io=gcr,quay.io=quay,registry.k8s.io=k8s`). Validated at startup; logged once on boot. |
| `pkg/models/types.go` | `RegistryRef` field on `ImageDistributionMetadata` extended with `Pushed bool` + `PushedAt time.Time`. No DTO shape break. |
| `internal/cluster/owner_watcher.go` | Stop short-circuiting on `ImageDistributionLocalOnly` for snapshots whose distribution mode flipped to `aocr`. |
| `internal/cluster/dead_owner.go` | Same. |
| `internal/cluster/placement.go` | `headroomScore` gains an optional image-locality bonus (F10) gated by config. |
| `internal/cluster/cluster.go` + heartbeat | SWIM capacity heartbeat extended with a bounded `TopKImageDigests` field (~32 entries). |
| `internal/config/config.go` | New env: `AOCR_HOST`, `AOCR_CLUSTER_ORG`, `AOCR_TOKEN_PATH`, `AOCR_MIRROR_HOST`, `AOCR_ENABLE_PUSH_ON_COMMIT`, `AOCR_PUSH_RETENTION_SUFFIX` (default `--idle-30d`), `AOCR_UPSTREAM_WRAP_KEY_PATH` (default `/etc/aerolvm/upstream-wrap.key`). |
| `internal/store/store.go` | Schema add for the optional pushed/pushed_at metadata on snapshot rows (mirrors `pkg/models` change). Test added in `store_test.go`. |
| `pkg/api/v1/handlers.go` | No new endpoint, but the snapshot create response now includes the resolved distribution mode (already in DTO; we ensure it is populated post-push). |
| `scripts/install.sh` | Write `/etc/docker/daemon.json` `registry-mirrors` block when `AOCR_MIRROR_HOST` is set. Idempotent: merges with existing config. Also drops the wrap key file with mode 0400 when provided. |
| `Ansible/playbooks/install-sandboxd.yml` | Same, idempotent. Add fact for cluster PAT path and wrap key path. |
| `Ansible/playbooks/rotate-upstream-wrap-key.yml` (new) | F19. Generate new key, push to AOCR Secret first (with overlap), then to each sandboxd node, then drop the old key after the overlap window. |
| `Ansible/roles/sandboxd/templates/daemon.json.j2` (new) | Templated mirror block. |
| `Ansible/roles/sandboxd/templates/upstream-wrap.key.j2` (new) | Templated key file, mode 0400. |
| `docs/src/content/docs/sandbox-images.mdx` (or equivalent) | Remove the "snapshots are pinned to origin node" caveat from the docs. |
| `docs/src/content/docs/cluster-mode.mdx` | Brief section on how AOCR + mirror feed cluster placement. |
| `pr-review.md` | Add a §section noting the new snapshot-push best-effort path and the `--idle-*` tag contract with AOCR — this is now part of the boot-and-snapshot critical path. |

### Tests required

AOCR side:
-   `hooks/test/imageRetention.provenance.test.ts` — three retention regimes coexist.
-   `hooks/test/mirrorBlobApi.test.ts` — presence query honours auth.
-   `hooks/test/snapshotApi.test.ts` — register/delete lifecycle.
-   `auth/src/__tests__/clusterPat.test.ts` (or equivalent) — cluster PAT
    scope enforcement.
-   `mirror/proxy_test.go` (if option B) — cache-miss → upstream → S3 →
    cache-hit. Multi-arch manifest pass-through. Upstream 429 surfaces.

AerolVM side:
-   `internal/service/snapshot_push_test.go` — push success flips mode to
    `aocr`; push failure leaves mode `local_only`.
-   `internal/service/snapshot_push_failover_test.go` — recreate failover
    accepted only when mode is `aocr`.
-   `internal/cluster/placement_image_affinity_test.go` — affinity bonus
    biases but does not pin.
-   Existing `store_test.go` + `layer4_bootstrap_test.go` patterns: any
    schema add gets a co-located regression test.

## Phased delivery

Each phase is a separately-shippable PR set. Earlier phases unblock later ones.

### Phase 0 — Schema + auth groundwork (AOCR only)
-   `db/init.sql` + `db/migrate-provenance.sql`.
-   `hooks/src/controllers/HookAPI.ts` stores provenance/cluster_id (no
    behavior change yet — defaults make every existing push behave as today).
-   `auth/src/server.ts` cluster-class PAT scope checks.
-   Helm values + secrets templates.
-   Tests: provenance backfill correctness, cluster PAT scope.

Ship → no AerolVM change yet, no user-visible change.

### Phase 1 — Snapshot push from AerolVM
-   `pkg/docker/client.go` `TagImage` + `PushImage`.
-   `internal/service/image_distribution.go` + `service.go` push-on-commit
    with best-effort fallback to `local_only`.
-   Config envs in `internal/config/`.
-   Tests for push success, push failure, idempotency under retry.
-   `pr-review.md` update.

Ship → snapshots become AOCR-resident. `recreate` failover still rejected
(unblocked in phase 2).

### Phase 2 — Recreate-on-failover unlock
-   Remove the structural rejection of `recreate` + snapshot in
    `internal/service/service.go`; replace with a resolved-mode check.
-   Update `internal/cluster/owner_watcher.go` and `dead_owner.go`.
-   End-to-end cluster test: kill origin node, sandbox recreates on another
    node from AOCR.

Ship → snapshot durability story is closed.

### Phase 3 — Mirror vhost + ref rewriter (anonymous upstreams only)
-   AOCR mirror module (option B above) supporting the public/anonymous
    portion of each upstream (DockerHub library + public user namespaces,
    registry.k8s.io, public ghcr/gcr/quay).
-   Helm `mirror.*` values, second Service, ingress with CIDR allow-list.
-   Hooks reaper: mirror provenance retention.
-   AerolVM installer/ansible writes `daemon.json` mirror config (F5,
    DockerHub only).
-   AerolVM `pkg/docker/mirror_rewrite.go` + pull-path integration (F5b,
    everything else). Tests for every upstream and the unknown-host
    passthrough. **Auth path stubbed**: if `RegistryAuth` is set, sandboxd
    rewrites but does NOT wrap; AOCR returns 401 with a clear "auth path
    not yet enabled" error. Acceptable interim because Phase 4 lands soon
    after.
-   Grafana dashboard panels (per-upstream cache-hit ratio).

Ship → public external pulls for all mapped upstreams go through AOCR, layer
dedup across snapshots and proxied bases, end users keep writing native refs.
Private images still need Phase 4.

### Phase 4 — Authenticated upstream support (F17–F20)
**Biggest single phase in the plan. Split across 3–4 PRs.**

PR 4a — Wrap/unwrap plumbing and key management
-   `auth/src/upstreamAuth/wrap.ts`, key list + rotation, replay defense.
-   `pkg/docker/upstream_wrap.go`, key loader on sandboxd side, file-mode
    check.
-   Helm secret + values, Ansible rotation playbook.
-   No behavioral wiring yet; pure infrastructure.

PR 4b — Auth service new validation strategy + proof cache (F17 + F18)
-   `validateUsingWrappedUpstream` strategy in `auth/src/server.ts`.
-   Proof cache (`auth/src/upstreamAuth/proofCache.ts`).
-   Manifest-probe step, scoped JWT minting with 15min TTL.
-   Tests for round-trip, replay, revocation, proof-cache hit/miss.

PR 4c — Upstream adapters (F20)
-   `auth/src/upstreamAuth/adapters/` with DockerHub, ghcr, quay, gcr,
    anonymous (k8s.gcr). Each adapter integration-tested against the real
    upstream in CI for at least one known public+private combo (the private
    case uses CI-only test creds).
-   ECR explicitly excluded; tracked separately.

PR 4d — Sandboxd wiring + end-to-end test
-   `pkg/docker/client.go` calls `WrapUpstreamCreds` when rewriting and
    creds are present.
-   Integration test: ghcr private image pulled end-to-end through mirror
    on a real cluster. Same image pulled on a second node serves from S3
    with a fresh proof. Wrong creds return 401 cleanly. Revoked creds lock
    out within 15min.

Ship → private images get the full mirror benefit. The majority user case
works.

### Phase 5 — Image-locality affinity (optional, deferred)
-   SWIM heartbeat extension (bounded top-K).
-   Placement scorer bonus, gated by config flag.
-   Per-node LRU tracker (lightweight, in-memory).
-   Tests confirming "bias not pin".

Ship → first-pull cost drops; warm nodes preferred but not required.

## Non-goals (explicitly out of scope)

-   **ECR (AWS) authenticated upstream.** F20 ships DockerHub, ghcr, quay,
    gcr, k8s.gcr. ECR uses AWS SigV4 + `GetAuthorizationToken` and pulls
    the AWS SDK into the auth service; added in a follow-up plan.
-   **Per-user pre-deployed upstream credentials.** All authenticated pulls
    use the per-create-call `registryAuth` flow (F17 wraps it). We do not
    let operators "save" upstream creds per user; the user supplies them
    at create time as today.
-   **P2P or torrent-style distribution** (Spegel / Dragonfly). S3 is fast
    enough inside one region for 1 TB of unique images and avoids the
    operational cost of a P2P overlay.
-   **Lazy layer materialization** (eStargz, SOCI). Out of scope; would
    require a different storage shape in S3.
-   **Replacing the Docker daemon's pull path** with a custom puller.
    `registry-mirrors` is enough.
-   **Bypassing upstream rate limits.** If DockerHub rate-limits AOCR, AOCR
    surfaces the rate limit; we do not rotate IPs or use multiple
    pull-through paths to evade it.
-   **Long-term storage of user upstream credentials.** Wrapped creds live
    only for the proof window in process memory. We do not persist them to
    disk or to Postgres.

## Risks and how we mitigate them

| Risk | Mitigation |
| :--- | :--- |
| Mirror vhost accidentally exposed publicly → freeloaders proxy DockerHub through our infra. | Ingress CIDR allow-list is mandatory; helm template fails closed when `mirror.allowList` is empty. Smoke test in Ansible. |
| Snapshot push slows down `CreateSnapshot` significantly. | Push runs after the user-visible commit succeeds; failure fallbacks to today's behavior. Latency budget surfaced in metrics. |
| Reaper deletes a snapshot still referenced by an alive sandbox. | `cluster_id` + `source_sandbox_id` on `images` lets the reaper consult AerolVM (or its own SnapshotAPI registry) for liveness before deletion. Default policy is conservative: idle TTL only. |
| Multi-arch manifest mismatch (cache returns wrong arch). | Cache key includes the arch-resolved manifest digest; manifest list cached separately. Distribution's content-addressing makes this automatic if we route correctly. |
| Cluster PAT leaks → attacker pushes garbage into `cluster/<id>/*`. | PAT is rotated by Ansible role; scope limits blast radius to one cluster's snapshot namespace; reaper's idle TTL ensures spam expires; alert on push-rate anomaly. |
| In-process custom proxy diverges from Distribution's blob handling. | Custom proxy writes to S3 *via* Distribution's own HTTP API (push vhost), not by writing S3 keys directly. We get Distribution's correctness for free. |
| Wrap key leaks → attacker can forge upstream auth proofs and convince AOCR to fetch arbitrary repos using their creds. | Wrap key is file-mode-0400 + node-local. AOCR refuses to start if `UPSTREAM_AUTH_WRAP_KEYS` is missing OR file mode is loose on sandboxd. Rotation runbook + alert on auth-strategy mix anomalies. AEAD includes a 10-min timestamp so a stolen wrapped blob cannot be replayed forever. |
| Cache poisoning: a malicious user with valid creds for repo X manages to write garbage that another user receives when they pull X. | Cache is content-addressed; user A cannot influence what blob digest corresponds to repo X — that's determined by upstream. The mirror fetches from upstream using upstream's signed manifest; if upstream serves it, that's the truth. Manifest mismatch between AOCR cache and upstream would require AOCR to be subverted, not the upstream protocol. |
| Cross-user cache leakage: user B receives content for a manifest they have not proved access to. | Manifest URLs require a scoped JWT issued only after upstream manifest HEAD succeeds for that user. Blob URLs are content-addressed and require the digest to be discoverable, which requires the manifest. Even a user knowing the digest from another channel still needs a JWT scoped to a repo that references that blob. |
| Upstream auth flow ddos from misconfigured users → AOCR hammers ghcr token endpoint. | Proof cache (F18) keys on `sha256(creds)` so repeated identical pulls collapse to one upstream handshake per 5 min. Per-upstream concurrency limit on the adapter. Alert on probe error-rate spike. |
| Wrap key rotation gone wrong → all pulls fail. | Auth service accepts BOTH current and previous keys for the 24h overlap window. Ansible playbook deploys to AOCR side first, then sandboxd side. Smoke-test pull after each side. Old key only dropped after monitoring window. |
| User changes their upstream password mid-pull → some layers succeed with cached upstream bearer, later layers 401. | Acceptable behavior: pull fails, user retries with new creds, fresh proof, fresh pull. The proof cache holds the upstream bearer for ≤5 min, so the inconsistency window is short. |

## Open questions for next round

1.  Confirm vhost names: `aocr.aerol.ai` (push) and `mirror.aocr.aerol.ai`
    (cache) vs. a different cache hostname like `cache.aocr.aerol.ai`.
2.  Mirror upstreams in v1: just `docker.io`, or also `ghcr.io`, `gcr.io`,
    `quay.io`, `registry.k8s.io` from day one?
3.  Custom proxy module language: Go (matches Distribution) or Node.js
    (matches hooks/auth)? Recommendation: Go.
4.  Snapshot push default retention: `--idle-30d` (proposed) or
    `--idle-90d`? Trade-off is S3 footprint vs. long-tail snapshot
    survivability.
5.  Cluster-snapshot SnapshotAPI (F9): MVP now, or defer to phase 3? It is
    not strictly required for phases 1–2 to be useful.

### Authenticated-mirror questions

6.  Proof cache TTL: **5 min default** proposed. Trade-off is upstream load
    vs. revocation latency. Confirm or override.
7.  Scoped-JWT TTL: **15 min default** proposed. Trade-off is handshake
    overhead vs. revocation latency. Confirm or override.
8.  Wrap key rotation cadence: **quarterly with 24h overlap** proposed.
    Confirm or specify.
9.  Per-upstream adapter ordering: ship all five in PR 4c, or stagger
    (DockerHub first, then ghcr, then others)? Recommend all five together
    because they share the same interface and writing one isolation test per
    adapter is cheap.
10. ECR roadmap: explicit follow-up plan after Phase 4 ships, or no
    commitment yet? If most of your authenticated users are on ghcr/quay,
    ECR can wait.
11. Phase 3 interim behavior when `RegistryAuth` is set: 401 with a clear
    message (proposed) or fall back to direct upstream pull just for that
    request (faster ship of usable cache for private images, at the cost of
    a behavior change between phases)? I lean 401 — predictable.
