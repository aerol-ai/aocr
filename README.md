# aerol.ai / aocr

**aocr** is an open-source authenticated OCI registry. It stores image metadata in PostgreSQL, stores layers and manifests in S3-compatible storage, and supports policy-based cleanup: plain tags stay latest-only while `--ttl-*` tags expire by age.

`aocr.aerol.ai` is one deployed instance of this repository. The instructions below explain how to use that hosted registry as an end user. If you want to deploy your own instance, follow [SELF_HOSTING.md](./SELF_HOSTING.md).

## What This Repository Provides

- **Authenticated access** with Docker token auth.
- **PAT-backed validation** against an upstream `/api/auth/info` endpoint.
- **Repository-aware cleanup** with a reaper that keeps plain tags latest-only and expires tags based on age (`--ttl-*`) or inactivity (`--idle-*`).
- **PostgreSQL metadata** for users, repositories, and pushed tags.
- **S3-compatible storage** for manifests and layers.
- **Helm for Kubernetes and Docker Compose for local development**.

## Use The Hosted Registry

These steps are for the public deployment at `aocr.aerol.ai`.

1. Sign in to `app.aerol.ai`.
2. Create or copy your registry token.
3. Use your `app.aerol.ai` username as the Docker login name. If your account does not expose a username, use the validated email instead.

The token is the password. The login name is only used to match the validated user profile.

```bash
export AEROL_LOGIN="your-app-username-or-email"
export AEROL_TOKEN="your-token-from-app-aerol-ai"

echo "$AEROL_TOKEN" | docker login aocr.aerol.ai -u "$AEROL_LOGIN" --password-stdin
docker tag my-image aocr.aerol.ai/aocr/my-image:main
docker push aocr.aerol.ai/aocr/my-image:main
docker tag my-image aocr.aerol.ai/aocr/my-image:main--ttl-7d
docker push aocr.aerol.ai/aocr/my-image:main--ttl-7d
docker tag my-image aocr.aerol.ai/aocr/my-image:main--idle-30d
docker push aocr.aerol.ai/aocr/my-image:main--idle-30d
docker pull aocr.aerol.ai/aocr/my-image:main
```

How hosted login works:
- The auth service accepts the token as the password for registry login.
- The presented login name must match the validated user profile's `id`, `username`, or `email`.
- End users never need the internal webhook secret used by the deployment.

Plain tags still follow latest-only cleanup. Tags with supported `--ttl-*` or `--idle-*` suffixes remain pullable until their respective policy expires.

Supported Age TTL suffixes include:

- `--ttl-1h`, `--ttl-6h`, `--ttl-24h`
- `--ttl-7d`, `--ttl-30d`, `--ttl-90d`, `--ttl-180d`, `--ttl-365d`
- aliases `--ttl-1month`, `--ttl-3month`, `--ttl-6month`, `--ttl-12month`

Supported Idle TTL suffixes include:

- `--idle-7d`, `--idle-30d`, `--idle-90d`, `--idle-180d`

For syntax details and operational caveats, see [RETENTION.md](./RETENTION.md).

## Images API

`GET /v1/images` on the auth service returns the tags AOCR knows about
along with their provenance, retention mode, and computed expiry.

Two scopes, distinguished by the credential:

- **Admin** — the static PAT (`auth.pat.token` /
  `aocr_auth_pat_token`) returns every image in the registry.
- **User** — a token validated through `auth.validationServiceUrl` is
  scoped to the caller's `external_id`; the response includes only
  images stored in repositories owned by that user.

```bash
# Admin (static PAT)
curl -sS -H "Authorization: Bearer $AOCR_PAT" \
  https://aocr.<domain>/v1/images?limit=50 | jq .

# Per-user (token from your validation service)
curl -sS -H "Authorization: Bearer $USER_TOKEN" \
  https://aocr.<domain>/v1/images | jq .
```

Each row carries `repository`, `tag`, `manifest_digest`, `provenance`
(`pushed` / `mirror` / `cluster-snapshot`), `upstream_ref`,
`retention_mode`, `retention_value_seconds`, `last_pushed_at`,
`last_pulled_at`, and an `expires_at` computed for `ttl` and `idle`
modes (`null` for `keep-latest`). Cluster PATs and wrapped-upstream
tokens are not supported on this endpoint and return `403
unsupported_scope`.

Pagination is server-driven. The response envelope is:

```json
{
  "limit": 100,
  "offset": 0,
  "count": 100,
  "has_more": true,
  "next_offset": 100,
  "images": [ ... ]
}
```

Default `limit` is `100`, hard cap `1000`. `has_more` is computed
cheaply by asking Postgres for one row past the page boundary, so
paging through a large registry never falls back to a `COUNT(*)`. Walk
the pages with `?offset=<next_offset>` until `has_more` is `false`.

## Deploy Your Own

If you want to run your own aocr instance:

- Follow [SELF_HOSTING.md](./SELF_HOSTING.md) for Helm and Docker Compose setup.
- Replace `aocr.aerol.ai` with your own registry hostname.
- Point `auth.validationServiceUrl` at your own auth-info endpoint.
- Issue your own user tokens from your own application or identity layer.

## Architecture

For the request and cleanup flow, see [understanding.md](./understanding.md).
For retention tag syntax and behavior, see [RETENTION.md](./RETENTION.md).
For metrics endpoints and the service-by-service metrics matrix, see [OBSERVABILITY.md](./OBSERVABILITY.md).
The repository also includes an importable Grafana dashboard at [deploy/grafana/aocr-observability-dashboard.json](./deploy/grafana/aocr-observability-dashboard.json).

## GitHub Actions

GitHub Actions only publishes packages:
- container images to `ghcr.io/aerol-ai/*`
- the Helm OCI chart to `oci://ghcr.io/aerol-ai/charts/aocr`

It does not deploy the stack. Deployment is expected to happen by running Helm against your Kubernetes cluster.
The published chart version is derived from `helm/aocr/Chart.yaml` plus a CI suffix such as `1.0.0-main.42`.

## Development

- Frontend: `cd web && npm install && npm run dev`
- Hooks API / reaper: `cd hooks && npm install && npx tsc`
- Auth service: `cd auth && corepack enable && pnpm install --frozen-lockfile && pnpm run build`
