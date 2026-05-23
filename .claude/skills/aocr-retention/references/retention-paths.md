# AOCR Retention Paths

## Core Ownership

| Concern | Owning File | Why |
| --- | --- | --- |
| Parse `--ttl-*` and `--idle-*` suffixes | `hooks/src/util/tagRetention.ts` | Maps tag suffixes to retention mode, seconds, and expiry |
| Infer image provenance | `hooks/src/util/tagRetention.ts` | Maps repo paths to `pushed`, `mirror`, or `cluster-snapshot` |
| Persist push metadata | `hooks/src/controllers/HookAPI.ts` | Upserts repositories and images on push |
| Persist pull activity for idle tags | `hooks/src/controllers/HookAPI.ts` | Updates `last_pulled_at` |
| Select stale images | `hooks/src/util/imageRetention.ts` | Postgres query for keep-latest, TTL, idle, and mirror expiry |
| Delete manifests | `hooks/src/util/imageRetention.ts` | Calls registry HEAD and DELETE endpoints |
| Schema contract | `db/init.sql` | Defines retention and provenance columns |
| User-facing behavior | `RETENTION.md` | Documents supported suffixes and GC caveat |

## Retention Decision Model

- Plain tags with no supported suffix become `keep-latest`.
- `--ttl-*` tags become `ttl` and get an `expires_at` timestamp at push time.
- `--idle-*` tags become `idle` and rely on `last_pulled_at` plus `retention_value_seconds`.
- Mirror images can expire through a default or per-prefix idle retention in `imageRetention.ts`.
- Cluster snapshot and mirror semantics are grounded by `provenance`, `cluster_id`, and `upstream_ref` columns.

## Debug Checklist

1. Confirm the incoming repository path and tag.
2. Check `inferredProvenance` and `parseTagRetention` in `hooks/src/util/tagRetention.ts`.
3. Verify whether the webhook path writes or refreshes the relevant row in `hooks/src/controllers/HookAPI.ts`.
4. Inspect the stale-image SQL in `hooks/src/util/imageRetention.ts` for the matching retention mode.
5. If behavior changed at the storage layer, inspect `registry/config.yml` and the registry event payload assumptions in `HookAPI.ts`.

## Related Tests And Docs

- `hooks/test/tagRetention.provenance.test.ts`
- `understanding.md`
- `plans/cluster-mirror-and-snapshot-distribution.md`