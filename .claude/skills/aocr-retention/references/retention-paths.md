# AOCR Retention Paths

## Core Ownership

| Concern | Owning File | Why |
| --- | --- | --- |
| Parse `--ttl-*` and `--idle-*` suffixes | `hooks/src/util/tagRetention.ts` | Maps tag suffixes to retention mode, seconds, and expiry |
| Infer image provenance | `hooks/src/util/tagRetention.ts` | Maps repo paths to `pushed`, `mirror`, or `cluster-snapshot` |
| Persist push metadata | `hooks/src/controllers/HookAPI.ts` | Upserts repositories and images on push |
| Persist pull activity for idle tags | `hooks/src/controllers/HookAPI.ts` | Updates `last_pulled_at` |
| Warm mirror content into hook-visible manifests | `mirror/proxy.go` | Writes manifests only after required blobs are present so registry notifications populate AOCR metadata |
| Route mirror requests to upstreams and storage paths | `mirror/router.go`, `mirror/upstream.go` | Decides which upstream owns a request and which `mirror/...` repo path hooks later classifies |
| Mirror-aware cluster imports | `hooks/src/controllers/ImportAPI.ts`, `hooks/src/util/mountFromRepo.ts` | Re-tags cached upstream content into `cluster/<cluster_id>/_imported/...` with retention suffixes |
| Blob presence checks for importers | `hooks/src/controllers/InternalAPI.ts` | Lets callers skip uploads when AOCR already has a blob |
| Select stale images | `hooks/src/util/imageRetention.ts` | Postgres query for keep-latest, TTL, idle, and mirror expiry |
| Delete manifests | `hooks/src/util/imageRetention.ts` | Calls registry HEAD and DELETE endpoints |
| Schema contract | `db/init.sql` | Defines retention and provenance columns |
| User-facing behavior | `RETENTION.md` | Documents supported suffixes and GC caveat |

## Retention Decision Model

- Plain tags with no supported suffix become `keep-latest`.
- `--ttl-*` tags become `ttl` and get an `expires_at` timestamp at push time.
- `--idle-*` tags become `idle` and rely on `last_pulled_at` plus `retention_value_seconds`.
- Mirror images can expire through a default or per-prefix idle retention in `imageRetention.ts`.
- Imported cluster images land under `cluster/<cluster_id>/_imported/<host>/<repo>:<tag><suffix>` and retain whatever suffix `ImportAPI` appends, defaulting to `--idle-90d`.
- Cluster snapshot and mirror semantics are grounded by `provenance`, `cluster_id`, and `upstream_ref` columns.

## Debug Checklist

1. Confirm the incoming repository path and tag.
2. Check `inferredProvenance` and `parseTagRetention` in `hooks/src/util/tagRetention.ts`.
3. Verify whether the webhook path writes or refreshes the relevant row in `hooks/src/controllers/HookAPI.ts`.
4. If the row never appeared after a mirror pull, inspect `mirror/proxy.go` and `mirror/writer.go` for cache warming and manifest PUT ordering.
5. If the issue is the cluster-owned imported copy, inspect `hooks/src/controllers/ImportAPI.ts`, `hooks/src/controllers/InternalAPI.ts`, and `hooks/src/util/mountFromRepo.ts`.
6. Inspect the stale-image SQL in `hooks/src/util/imageRetention.ts` for the matching retention mode.
7. If behavior changed at the storage layer, inspect `registry/config.yml` and the registry event payload assumptions in `HookAPI.ts`.

## Related Tests And Docs

- `hooks/test/imageRetention.mirror.test.ts`
- `hooks/test/importApi.test.ts`
- `hooks/test/mountFromRepo.test.ts`
- `hooks/test/tagRetention.provenance.test.ts`
- `mirror/integration_test.go`
- `MIRROR.md`
- `aocr_aerol_stitch.md`
- `understanding.md`
- `plans/cluster-mirror-and-snapshot-distribution.md`