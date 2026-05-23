# AOCR Pull-Through Mirror

AOCR can front a curated set of public container registries as a
pull-through cache. Clients pull from `mirror.<domain>` (default
`mirror.aerol.ai`); cached content is persisted to AOCR's S3 backend
under `mirror/<upstream>/<repo>` and tracked in Postgres with
`provenance='mirror'`.

The mirror is a separate vhost from the push registry
(`aocr.<domain>`). They share storage and tracking, but have separate
auth, ingress, and access controls.

## Architecture

```
client docker pull --> mirror.<domain> (Ingress, CIDR-gated)
                       |
                       v
                   aocr-mirror Pod
                   ┌────────────────────────────────────────┐
                   │ mirror (Go proxy, port 5100)           │
                   │   - parses /v2/.../{manifests,blobs}/X │
                   │   - HEAD against writer for cache hit  │
                   │   - on miss: fetch upstream, tee bytes │
                   │     to (client, writer-upload-pipe)    │
                   │                                        │
                   │ writer (Distribution 2.8, port 5050)   │
                   │   - htpasswd auth, bound to 127.0.0.1  │
                   │   - same S3 bucket as the main         │
                   │     registry; same notification hook   │
                   └────────────────────────────────────────┘
                                  │
                                  v
                  S3: mirror/<upstream>/<repo>/{blobs,manifests}/...
                                  │
                                  v   webhook
                              aocr-hooks
                                  │
                                  v
                  Postgres: images.provenance = 'mirror',
                            images.upstream_ref = '<upstream>/<repo>'
```

The `mirror/` storage prefix is what makes Phase 0's
`inferredProvenance()` automatically classify mirror-fetched content as
`provenance='mirror'`. No special-case code in hooks.

## Day-1 upstreams

| URL path prefix             | Upstream         | Notes                                  |
| --------------------------- | ---------------- | -------------------------------------- |
| `/v2/library/<repo>`        | `docker.io`      | DockerHub "library" namespace shortcut |
| `/v2/<user>/<repo>`         | `docker.io`      | User/org namespaces                    |
| `/v2/_/ghcr/<org>/<repo>`   | `ghcr.io`        | GitHub Container Registry              |
| `/v2/_/gcr/<proj>/<repo>`   | `gcr.io`         | Google Container Registry              |
| `/v2/_/quay/<org>/<repo>`   | `quay.io`        | Red Hat Quay                           |
| `/v2/_/k8s/<repo>`          | `registry.k8s.io`| Kubernetes community registry          |

`*-docker.pkg.dev` and `*.azurecr.io` are on the roadmap but require
authenticated upstream credentials and will land with Phase 4.

## What the mirror does

- Caches anonymous-public manifests and blobs on first request.
- Streams responses to the client in a single pass (`io.MultiWriter`
  tee to the writer sidecar's upload pipe) — no buffer-then-upload.
- Exposes its own ingress on `mirror.<domain>`, CIDR-gated by
  `mirror.allowList`.
- Reports cache hits/misses, upstream errors, and bytes served at
  `:5100/metrics`.
- Honors the Phase-3 reaper retention policy: mirror-provenance images
  expire after `mirror.defaultIdleSeconds` (default 30 days) idle, with
  per-upstream overrides via `mirror.retentionOverrides`.

## What the mirror does NOT do

- It does not perform pushes. The push vhost (`aocr.<domain>`) is the
  only writable surface from outside the cluster.
- It does not relay authentication credentials. All Day-1 upstreams are
  pulled anonymously; authenticated upstreams arrive in Phase 4.
- It does not serve `/v2/_catalog` or `tags/list` — only manifest and
  blob GET/HEAD per the Distribution v2 read surface.
- It does not validate digests. The upstream's `Docker-Content-Digest`
  header is trusted; client tooling does its own digest check on the
  returned bytes.

## Operations

### Enable the mirror

```yaml
mirror:
  enabled: true
  host: ""               # defaults to mirror.<global.domain>
  allowList:             # REQUIRED when enabled
    - 10.0.0.0/8
    - 172.16.0.0/12
  writerUsername: mirror-writer
  writerPassword: change-me-writer
```

The Helm chart fails closed if `mirror.enabled` is true but
`mirror.allowList` is empty.

### Verify the mirror is up

The mirror only registers four routes: `/v2/`, `/v2`, `/metrics`, and
`/healthz`. Anything else (including `/`) returns `404 page not found` —
this is expected, same as Docker Distribution itself.

```bash
curl -i https://mirror.<domain>/healthz   # → 200 OK
curl -i https://mirror.<domain>/v2/       # → 401 Unauthorized (auth challenge) = healthy
curl -i https://mirror.<domain>/          # → 404 page not found (expected)
```

A 401 on `/v2/` is the canonical "registry is up and asking for a token."

### Use the mirror as a Docker daemon

```json
// /etc/docker/daemon.json on the client
{
  "registry-mirrors": ["https://mirror.aerol.ai"]
}
```

DockerHub pulls (`docker pull redis`) flow through the mirror
automatically. For ghcr/gcr/quay/k8s, rewrite the reference:

```bash
docker pull mirror.aerol.ai/_/ghcr/aerol-ai/sandbox:v1
```

### Tune retention

```yaml
mirror:
  defaultIdleSeconds: 2592000   # 30 days
  retentionOverrides:
    docker/library/: 604800     # 7 days for popular base images
    k8s/: 7776000               # 90 days for k8s images we always need
```

Overrides match `upstream_ref` LIKE-prefix (the storage path under
`mirror/`). The longest-prefix-wins, with the default applied if nothing
matches.

### Blob-presence API (F8)

The hooks service exposes a tiny internal API used by mirror-aware
importers (AerolVM in later phases) to skip uploading layers AOCR
already has:

```
GET /v1/internal/blobs/<repository>/<sha256:digest>
Authorization: Token <hooks.internalApiToken>

→ 200 {"present": true,  "digest": "sha256:...", "repository": "...", "sizeBytes": 12345}
  200 {"present": false, "digest": "sha256:...", "repository": "...", "sizeBytes": null}
  502 {"error": "registry_unreachable"}
```

## Local development

`docker compose up mirror mirror-writer` will start both containers
locally. The writer uses Distribution's `silly` auth (accepts anything)
since there is no need to harden a localhost dev surface; in Kubernetes
the writer runs with htpasswd against a Kubernetes Secret.
