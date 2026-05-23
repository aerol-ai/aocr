# Retention

`aocr` supports two retention behaviors today:

- plain tags use latest-only cleanup
- tags with supported `--ttl-*` suffixes expire by age

## Tag Syntax

The proposed `~~` syntax is not valid Docker tag syntax. Use legal OCI tag suffixes instead.

Examples:

```bash
docker push registry.example.com/aocr/my-image:main
docker push registry.example.com/aocr/my-image:main--ttl-1h
docker push registry.example.com/aocr/my-image:main--ttl-7d
docker push registry.example.com/aocr/my-image:main--ttl-1month
```

The full suffixed tag is the real tag. Pulls must use the same full tag.

## Supported TTL Suffixes

Canonical suffixes:

- `--ttl-1h`
- `--ttl-6h`
- `--ttl-24h`
- `--ttl-7d`
- `--ttl-30d`
- `--ttl-90d`
- `--ttl-180d`
- `--ttl-365d`

Accepted aliases:

- `--ttl-1month` maps to `30d`
- `--ttl-3month` maps to `90d`
- `--ttl-6month` maps to `180d`
- `--ttl-12month` maps to `365d`

## Current Behavior

- plain tags like `main` continue to use latest-only cleanup
- `--ttl-*` tags are stored with an `expires_at` timestamp derived from push time
- repushing the same full TTL tag refreshes `last_pushed_at` and `expires_at`
- expired TTL tags are deleted by the reaper through the registry manifest delete API

## Storage Reclamation Caveat

Manifest deletion makes blobs eligible for registry garbage collection, but it does not immediately free underlying storage.

Docker Distribution still needs a separate mark-and-sweep garbage collection run to reclaim unreferenced blobs. That operational workflow is separate from phase-1 TTL support.

## Upgrade Note

For an existing deployment, run [db/migrate-retention-policies.sql](./db/migrate-retention-policies.sql) before rolling out the updated hooks and reaper images.