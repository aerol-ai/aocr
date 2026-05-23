# Understanding aocr

This document describes how the authenticated OCI registry works with latest-only cleanup for plain tags and age-based TTL cleanup for `--ttl-*` tags.

## The Life of a `docker push`

When you run `docker push <registry-host>/aocr/my-image:main`, the flow is:

1. **Registry upload**: Docker authenticates with the auth service and pushes the manifest and layers into the registry.
2. **Notification trigger**: Docker Distribution sends a registry event to `hooks` at `/v1/hook/registry-event`.
3. **Metadata sync**: The hook stores the repository and tag in PostgreSQL and updates `last_pushed_at` for that repository/tag pair.
4. **Retention metadata sync**: The hook stores the repository and tag in PostgreSQL, updates `last_pushed_at`, and records retention policy metadata for supported `--ttl-*` tags.
5. **Immediate cleanup**: After the push is recorded, the hook reaps stale plain tags for that repository.
6. **Retention cleanup**: The scheduled reaper scans PostgreSQL and deletes plain tags beyond the newest one plus TTL tags whose `expires_at` has passed.

| Component | Role | Technology |
| :--- | :--- | :--- |
| Registry | OCI registry and notification source | Docker Distribution v2 |
| Hook API | Tracks pushed repositories/tags | Node.js + TypeScript |
| Auth Service | Docker token auth and user sync | Node.js + TypeScript |
| Reaper | Deletes stale manifests and metadata | Node.js + TypeScript |
| Storage | Stores blobs and manifests | S3 / Minio |
| Metadata | Tracks users, repositories, and image pushes | PostgreSQL |
| Legacy cache | Optional compatibility cache | Redis |

## Metadata Model

PostgreSQL is the source of truth:

- `users` stores authenticated users from the upstream validation service.
- `repositories` stores the organization/repository namespace.
- `images` stores pushed tags, `last_pushed_at`, and retention metadata.

The registry stores layers and manifests in S3-compatible storage. PostgreSQL tells the reaper which tags are stale; the registry API performs the actual delete.

## Retention Reaper

The reaper is policy-aware:

1. It ranks `keep-latest` images within each `repository_id` by `last_pushed_at`.
2. It keeps the newest plain tag for that repository.
3. It deletes older `keep-latest` tags and any `ttl` tags whose `expires_at` is in the past.
4. It deletes the matching metadata rows after registry deletion succeeds or the tag is already gone.

If `REPOSITORY_IDS` is empty, the scheduled reaper sweeps all repositories. If it is set, the cron job limits itself to those repository UUIDs.

## TTL Tags

Supported phase-1 TTL tags use legal OCI tag suffixes such as:

- `main--ttl-1h`
- `main--ttl-7d`
- `main--ttl-30d`
- `main--ttl-1month`

The full suffixed tag is the real tag users push and pull.

## Deployment Paths

- **Helm** packages the full stack for Kubernetes and now includes the registry config and database SQL inside the chart itself.
- **Docker Compose** runs the same services for local development only.
- **GitHub Actions** builds `auth`, `hooks`, `reaper`, `registry`, and `web`, pushes them to GHCR, and publishes the Helm chart as an OCI package.
