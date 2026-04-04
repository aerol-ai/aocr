# aerol.ai / aocr

**aocr** is an authenticated OCI registry for **aerol.ai**. It stores image metadata in PostgreSQL, stores layers/manifests in S3-compatible storage, and automatically removes older tags so each repository keeps only its latest image.

## Key Features
- **Authenticated access** with Docker token auth.
- **PAT-backed validation** against an upstream `/api/auth/info` endpoint.
- **Repository-aware cleanup** with a reaper that keeps the newest image per repository.
- **PostgreSQL metadata** for users, repositories, and pushed tags.
- **S3-compatible storage** for manifests and layers.
- **Helm for Kubernetes and Docker Compose for local development**.

## Quick Start

Push a standard tag. No TTL suffix is required:

```bash
docker tag my-image aerol.ai/aocr/my-image:main
docker push aerol.ai/aocr/my-image:main
```

When a newer image is pushed to the same repository, the hook immediately starts removing older image records and registry manifests for that repository. The scheduled reaper still runs separately and sweeps the database, keeping only the newest image per repository.

For the architecture flow, see [understanding.md](./understanding.md).

## Deployment

### Kubernetes with Helm

```bash
helm install aocr oci://ghcr.io/aerol-ai/charts/aocr \
  --namespace aerol-system \
  --create-namespace \
  --version <published-chart-version> \
  --set image.repository="ghcr.io/aerol-ai" \
  --set image.tag="latest" \
  --set global.domain="aocr.aerol.ai" \
  --set postgres.password="CHANGE_ME_POSTGRES_PASSWORD" \
  --set redis.password="CHANGE_ME_REDIS_PASSWORD" \
  --set hooks.token="CHANGE_ME_HOOK_SHARED_SECRET" \
  --set registry.replregSecret="CHANGE_ME_REGISTRY_HTTP_SECRET" \
  --set registry.s3.region="us-east-1" \
  --set registry.s3.bucket="aocr" \
  --set registry.s3.endpoint="https://s3.amazonaws.com" \
  --set registry.s3.accessKey="CHANGE_ME_S3_ACCESS_KEY" \
  --set registry.s3.secretKey="CHANGE_ME_S3_SECRET_KEY" \
  --set auth.validationServiceUrl="https://anek.ai/api/auth/info" \
  --set-file auth.jwtPrivateKey="/path/to/jwt-private.pem" \
  --set-file auth.jwtPublicKey="/path/to/jwt-public.pem"
```

Required values and what they do:
- `postgres.password`: password used by the in-cluster PostgreSQL instance.
- `redis.password`: password used by the in-cluster Redis instance.
- `hooks.token`: shared secret used by the registry notification webhook. The registry sends `Authorization: Token <hooks.token>` and the hooks service rejects notifications if it does not match.
- `registry.replregSecret`: Docker Distribution HTTP secret. This should be a stable random string for the registry instance.
- `registry.s3.accessKey` and `registry.s3.secretKey`: credentials for the S3-compatible object store where image layers and manifests are stored.
- `auth.jwtPrivateKey`: private key used by the auth service to sign Docker registry bearer tokens.
- `auth.jwtPublicKey`: public key mounted into the registry so it can verify the JWTs signed by `auth.jwtPrivateKey`.

Why the JWT key pair exists:
- The auth service issues the bearer token that Docker uses after login.
- The registry must verify that token before allowing push or pull.
- The private key stays only with the auth service.
- The matching public key is mounted into the registry as `auth.crt` and referenced by the registry token configuration.

Why these are passed during Helm install:
- The chart is generic and cannot safely hardcode production secrets.
- Helm values are how you bind your environment-specific configuration to the chart at deploy time.
- For PEM files, use `--set-file` instead of `--set`, because multiline keys are awkward and error-prone on the command line.

If you prefer, you can put the same values into a dedicated production values file and install with:

```bash
helm install aocr oci://ghcr.io/aerol-ai/charts/aocr \
  --namespace aerol-system \
  --create-namespace \
  --version <published-chart-version> \
  -f values-prod.yaml
```

### Docker Compose

For local development only:

```bash
cp .env.example .env
docker compose up -d
```

`REPOSITORY_IDS` is optional. Leave it empty to sweep all repositories, or set one or more UUIDs to limit the cron job scope.
`VALIDATION_SERVICE_URL` should point to the upstream auth-info endpoint that accepts `Authorization: Bearer <ank_...>` and returns user identity details.

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
