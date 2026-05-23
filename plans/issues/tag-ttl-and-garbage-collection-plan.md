# Tag TTL And Garbage Collection Plan

## Goal

Add opt-in retention policies that can be attached to pushed image tags, while keeping the registry safe to operate at roughly 1000 tracked images and up to about 1 TB of unique image data.

This plan covers two related but distinct problems:

1. tag retention policy selection at push time
2. actual storage reclamation after manifests are deleted

The current repository only supports latest-only retention. It explicitly moved away from TTL tags, stores `last_pushed_at`, and deletes every image except the newest one per repository.

## Important Constraints

### 1. The proposed `~~` syntax is not valid Docker tag syntax

Docker rejects tags like `main~~1h`. We need a legal OCI tag encoding.

Recommended encoding:

- `aocr/my-image:main--ttl-1h`
- `aocr/my-image:main--ttl-6h`
- `aocr/my-image:main--ttl-24h`
- `aocr/my-image:main--ttl-7d`
- `aocr/my-image:main--ttl-30d`
- `aocr/my-image:main--ttl-90d`
- `aocr/my-image:main--ttl-180d`
- `aocr/my-image:main--ttl-365d`
- `aocr/my-image:main--idle-7d`
- `aocr/my-image:main--idle-30d`
- `aocr/my-image:main--idle-90d`
- `aocr/my-image:main--idle-180d`

Notes:

- `ttl-*` means delete after elapsed time since push.
- `idle-*` means delete after a period with no manifest pull.
- The suffix is part of the real OCI tag. Pulls must use the full tag.
- If we want a stable pull tag like `main` plus separate TTL metadata, that is a different design and requires an out-of-band control plane.

### 2. Age TTL is much simpler than idle TTL

Age TTL only needs push-time parsing and scheduled expiry.

Idle TTL needs pull tracking. The registry can emit `pull` notifications, but we must:

- process only manifest pull events
- persist `last_pulled_at`
- avoid write amplification under repeated pulls

### 3. Manifest deletion is not the same as storage reclamation

Deleting manifests through the registry API makes blobs eligible for garbage collection, but it does not immediately free underlying storage. Docker Distribution still needs a mark-and-sweep garbage collection run, and the upstream guidance is to run that with the registry in read-only mode or fully stopped.

## Recommended Delivery Order

### Phase 1: Age TTL tags

Implement only push-age retention first.

This phase supports:

- `ttl-1h`
- `ttl-6h`
- `ttl-24h`
- `ttl-7d`
- `ttl-30d`
- `ttl-90d`
- `ttl-180d`
- `ttl-365d`

This is the best first slice because it replaces the current latest-only policy without needing high-volume pull writes.

### Phase 2: Idle TTL tags

Add `idle-*` retention once age TTL is stable and measured.

This phase supports:

- `idle-7d`
- `idle-30d`
- `idle-90d`
- `idle-180d`

### Phase 3: Real blob garbage collection

Add a controlled operational path for registry mark-and-sweep GC so expired manifests eventually free S3-backed blob storage.

## Proposed Retention Model

Add explicit metadata to `images` instead of inferring policy from ranking rules alone.

Suggested columns:

- `retention_mode` with values `keep-latest`, `ttl`, `idle`
- `retention_value_seconds`
- `expires_at`
- `last_pulled_at`
- `manifest_digest`
- `raw_retention_suffix`

Behavior:

- tags without a recognized suffix default to `keep-latest`
- `ttl-*` tags compute `expires_at = pushed_at + duration`
- `idle-*` tags set `last_pulled_at = last_pushed_at` initially and expire when `now - last_pulled_at > duration`
- the reaper deletes only images whose policy says they are eligible
- `keep-latest` tags preserve current behavior, but only inside that policy bucket

## File Change Map

### Database

- `db/init.sql`
  - add retention columns to `images`
  - add indexes for `expires_at`, `last_pulled_at`, and repository policy queries
  - keep compatibility for existing rows by backfilling `keep-latest`

- `db/migrate-latest-only.sql`
  - stop being the target retention shape
  - either replace it with a new retention migration or add a new migration file for TTL rollout

Recommended new file:

- `db/migrate-retention-policies.sql`
  - migrate existing rows to `retention_mode='keep-latest'`
  - populate `expires_at` and `last_pulled_at` defaults where needed

### Hooks ingestion and retention logic

- `hooks/src/controllers/HookAPI.ts`
  - parse push tag suffixes into normalized retention policy metadata
  - store retention policy fields during push events
  - in phase 2, process `pull` events for manifest targets and update `last_pulled_at`
  - avoid per-blob pull updates by filtering on event target media type and tag presence

- `hooks/src/util/imageRetention.ts`
  - replace latest-only ranking logic with policy-aware eligibility logic
  - keep `keep-latest` semantics for plain tags
  - delete only rows eligible by `expires_at` or `last_pulled_at`
  - continue manifest deletion by digest, but use stored `manifest_digest` when available to avoid extra HEAD calls where possible

Recommended new file:

- `hooks/src/util/tagRetention.ts`
  - parse legal suffixes like `--ttl-7d` and `--idle-30d`
  - normalize aliases into canonical durations
  - reject unsupported suffixes deterministically
  - expose helpers shared by hook ingestion and tests

- `hooks/src/commands/reap.ts`
  - no major logic change, but document and wire any new reaper batch or dry-run options if we add them

### Registry and blob GC

- `registry/entrypoint.sh`
  - keep runtime config rendering
  - add a controlled path for running `registry garbage-collect`
  - do not auto-run GC on every start

- `registry/config.yml`
  - add optional read-only maintenance mode templating if we choose a GC window workflow

- `helm/aocr/files/registry-config.yml`
  - mirror the same registry config changes used by the runtime image

Recommended new file:

- `registry/garbage-collect.sh`
  - wrap `registry garbage-collect`
  - support dry-run and delete modes
  - assume registry is already read-only or stopped

### Helm and Compose wiring

- `helm/aocr/values.yaml`
  - add retention configuration block
  - add GC configuration block
  - add feature flags so rollout is explicit

Suggested values structure:

```yaml
retention:
  enabled: false
  allowAgeTtl: true
  allowIdleTtl: false
  defaultMode: keep-latest
  supportedAgePolicies:
    - 1h
    - 6h
    - 24h
    - 7d
    - 30d
    - 90d
    - 180d
    - 365d
  supportedIdlePolicies:
    - 7d
    - 30d
    - 90d
    - 180d

registryGc:
  enabled: false
  dryRun: true
  schedule: "0 3 * * *"
  requireReadOnly: true
```

- `helm/aocr/templates/reaper.yaml`
  - pass retention feature env vars into the reaper CronJob
  - in a later phase, optionally add a separate GC CronJob instead of overloading the reaper job

- `helm/aocr/templates/registry.yaml`
  - pass GC and read-only mode env vars to registry
  - if we implement a GC job, mount the same config and credentials there

- `docker-compose.yaml`
  - add retention feature env vars for hooks and reaper
  - keep blob GC off by default

Recommended new file:

- `docker-compose.gc.yaml`
  - optional override file for local GC testing
  - never part of the default local stack

- `.env.example`
  - document retention and GC feature flags

### Documentation

- `README.md`
  - update hosted usage examples once the feature exists
  - document the legal tag suffix syntax instead of the invalid `~~` syntax

- `SELF_HOSTING.md`
  - explain how to enable retention policies
  - explain that storage reclamation requires the separate GC workflow

- `understanding.md`
  - replace the latest-only description with policy-based retention behavior

Recommended new file:

- `RETENTION.md`
  - central document for tag policy syntax, examples, lifecycle, and operational caveats

## Exact Behavior To Implement

### Phase 1 behavior

- A push to `aocr/my-image:main--ttl-7d` stores the full tag and records policy `ttl`, duration `7d`, and `expires_at`
- The image remains pullable by the exact same full tag until expiration
- The reaper deletes it only after `expires_at <= now()`
- Plain tags like `main` continue to use current `keep-latest` semantics unless we later change the default policy

### Phase 2 behavior

- A push to `aocr/my-image:main--idle-30d` stores policy `idle`, duration `30d`, and initializes `last_pulled_at`
- Manifest pull events refresh `last_pulled_at`
- The reaper deletes only after the image has been idle longer than the policy duration

### Phase 3 behavior

- Reaper deletes expired manifests through the registry API
- A separate GC operation reclaims unreferenced blobs later
- GC runs only in an explicit maintenance window with the registry read-only or stopped

## Scaling Assessment

## 1000 tracked images

This is not large for PostgreSQL or for the retention metadata layer.

Expected shape:

- `repositories` and `images` stay small
- indexed expiry scans are cheap
- scheduled reaper runs remain lightweight

Phase 1 should scale comfortably here.

## 1 TB of unique image data

This is mainly a storage-operations problem, not a metadata problem.

What should scale reasonably well:

- S3-compatible object storage for blob bytes
- PostgreSQL metadata for policy evaluation
- scheduled SQL scans with the right indexes

What becomes operationally sensitive:

- mark-and-sweep GC duration
- read-only maintenance windows
- number of unique blobs, which matters more than tag count alone

Important distinction:

- expiring manifests scales fine
- reclaiming 1 TB of unique blob data is slower and must be handled as a separate GC operation

## Risks And Design Decisions

### 1. Tag suffixes are real tags

If users need to pull `main`, then `main--ttl-7d` is not a transparent alias. This plan assumes the suffixed tag is the actual tag users pull.

### 2. Idle TTL can create write amplification

If every pull updates Postgres directly, hot images will cause avoidable writes. If phase 2 is implemented, add one of these protections:

- only update `last_pulled_at` once per image per short interval
- buffer pull timestamps in Redis and flush periodically
- skip updates when the stored value is already recent enough

### 3. S3 lifecycle rules are not enough

The registry blob store is reference-based. We cannot safely delete objects only by age in S3 because shared layers may still be referenced by live manifests.

### 4. Month-based policies should be normalized

Avoid calendar-month arithmetic in the storage layer. Normalize:

- `1month` -> `30d`
- `3month` -> `90d`
- `6month` -> `180d`
- `12month` -> `365d`

## Implementation Sequence

1. Add a planning-safe schema and migration for retention policy metadata.
2. Add tag suffix parsing helpers with tests.
3. Update push webhook handling to persist retention metadata.
4. Replace latest-only reaper SQL with policy-aware expiry logic.
5. Update docs and examples for legal suffix syntax.
6. Validate age TTL end to end.
7. Add manifest pull tracking for idle policies.
8. Add explicit registry GC operational tooling.

## Validation Plan

### Phase 1 validation

- unit tests for suffix parsing and normalization
- unit tests for reaper eligibility selection
- local integration test: push tag with `--ttl-1h`, backdate or mock time, reap, verify manifest delete path
- Helm render validation for new env/config wiring

### Phase 2 validation

- integration test for manifest pull event updating `last_pulled_at`
- repeated pull simulation to verify write throttling behavior

### Phase 3 validation

- dry-run GC first
- verify read-only maintenance workflow
- verify blob count falls only after GC, not merely after manifest delete

## Recommendation

Implement phase 1 first and keep phase 2 and phase 3 separate.

That gives a useful TTL feature with manageable complexity and avoids introducing pull-path write pressure before we have measured it.