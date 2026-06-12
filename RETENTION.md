# Retention Policies and Garbage Collection

`aocr` supports policy-based retention for Docker image tags. Instead of relying on external scripts to clean up your registry, aocr has a built-in Reaper that enforces retention policies directly.

## Retention Modes

aocr supports three primary retention behaviors:

1. **Keep Latest (Default)**
2. **Age TTL (`--ttl-*`)**
3. **Idle TTL (`--idle-*`)**

### 1. Keep Latest
If a tag does not have a special retention suffix (e.g., `my-image:main`), aocr automatically defaults to a `keep-latest` policy. 
Within a given repository, aocr will only keep the newest pushed tag that does not have a special retention suffix. All older plain tags will be reaped.

### 2. Age TTL
Tags appended with an `--ttl-*` suffix are kept for a specific duration measured from the time they were pushed. 
For example, `my-image:main--ttl-7d` will be preserved for exactly 7 days after it is pushed, and then the Reaper will delete it.

Supported Age TTL suffixes:
- `--ttl-1h`
- `--ttl-6h`
- `--ttl-24h`
- `--ttl-7d`
- `--ttl-30d`
- `--ttl-90d`
- `--ttl-180d`
- `--ttl-365d`

Aliases: `--ttl-1month`, `--ttl-3month`, `--ttl-6month`, `--ttl-12month`

### 3. Idle TTL
Tags appended with an `--idle-*` suffix are kept as long as they are actively being pulled. 
For example, `my-image:main--idle-30d` will be preserved as long as it has been pulled at least once in the last 30 days. If 30 days pass with zero pulls, the Reaper will delete it.

Supported Idle TTL suffixes:
- `--idle-7d`
- `--idle-30d`
- `--idle-90d`
- `--idle-180d`

## Important Caveat: Suffixes are Real Tags
Docker does not support metadata aliases without an external control plane. If you push an image with a `--ttl-7d` suffix, the user must pull it using that exact suffix:
```bash
docker pull aocr.aerol.ai/aocr/my-image:main--ttl-7d
```

## Provenance (Phase 0 Groundwork)

Each image row now carries a `provenance` column with one of three values:

- `pushed` (default) — a user push into a normal `<org>/<repo>` namespace. This is the existing behavior; retention follows the keep-latest, `--ttl-*`, or `--idle-*` rules above.
- `cluster-snapshot` — an AerolVM sandbox snapshot pushed into the `cluster/<cluster_id>/...` namespace. Populated when push-on-commit lands in Phase 1; not produced by current clients.
- `mirror` — a layer or manifest cached from an upstream registry by the pull-through mirror under `mirror/...`. Populated when the mirror vhost lands in Phase 3; not produced by current clients.

The retention rules above still apply uniformly across all three. Provenance-aware retention (different idle defaults per provenance, snapshot-liveness checks, etc.) is layered on in later phases. For details on cluster snapshots and the mirror cache, see [`plans/cluster-mirror-and-snapshot-distribution.md`](./plans/cluster-mirror-and-snapshot-distribution.md).

## Protected Namespaces (Standard WASM Modules)

Some repositories must never be reaped regardless of the rules above. AerolVM
stages curated standard WASM language runtimes under `wasm/std/*` (e.g.
`wasm/std/python:3.12`) and pins each module's content digest into every sandbox
across the fleet. Under the default keep-latest rule, pushing a newer standard
tag would reap the older one and silently break every pinned digest still
booting it.

The Reaper therefore excludes a configurable set of protected repo-path
prefixes from **all** selection (keep-latest, `--ttl-*`, `--idle-*`, mirror):

- `AOCR_WASM_STD_NAMESPACE` (default `wasm/std`) — the standard-module
  namespace. The auth service also makes this prefix pull-only for tenant
  cluster PATs (writable only by the static/system PAT).
- `AOCR_RETENTION_PROTECTED_NAMESPACES` — optional comma/newline-separated list
  of additional prefixes. Defaults to `AOCR_WASM_STD_NAMESPACE` when unset.

A prefix protects both the namespace root and everything beneath it
(`wasm/std` and `wasm/std/python`) but not an unrelated repo that merely shares
the string prefix (`wasm/stdlib-evil` is still reaped normally).

## Storage Reclamation (Garbage Collection)
When the Reaper deletes an expired tag, it only deletes the **manifest** (the metadata linking the tag to its underlying layer blobs). The actual gigabytes of layer data remain in S3 because they might be shared by other active images.

To physically free up S3 storage space, you must run Garbage Collection:
1. Garbage Collection scans the S3 bucket for blobs that are no longer referenced by any active manifest.
2. It permanently deletes those orphaned blobs.

Garbage Collection is configured via the `registryGc` section in your Helm `values.yaml` file, which sets up a `CronJob` to handle this operation efficiently. For local testing, you can use `docker-compose -f docker-compose.yaml -f docker-compose.gc.yaml up registry-gc`.