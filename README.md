# aerol.ai / aocr

**aocr** is an open-source authenticated OCI registry. It stores image metadata in PostgreSQL, stores layers and manifests in S3-compatible storage, and automatically removes older tags so each repository keeps only its latest image.

`aocr.aerol.ai` is one deployed instance of this repository. The instructions below explain how to use that hosted registry as an end user. If you want to deploy your own instance, follow [SELF_HOSTING.md](./SELF_HOSTING.md).

## What This Repository Provides

- **Authenticated access** with Docker token auth.
- **PAT-backed validation** against an upstream `/api/auth/info` endpoint.
- **Repository-aware cleanup** with a reaper that keeps the newest image per repository.
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
docker pull aocr.aerol.ai/aocr/my-image:main
```

How hosted login works:
- The auth service accepts the token as the password for registry login.
- The presented login name must match the validated user profile's `id`, `username`, or `email`.
- End users never need the internal webhook secret used by the deployment.

When a newer image is pushed to the same repository, the hook immediately starts removing older image records and registry manifests for that repository. The scheduled reaper still runs separately and sweeps the database, keeping only the newest image per repository.

## Deploy Your Own

If you want to run your own aocr instance:

- Follow [SELF_HOSTING.md](./SELF_HOSTING.md) for Helm and Docker Compose setup.
- Replace `aocr.aerol.ai` with your own registry hostname.
- Point `auth.validationServiceUrl` at your own auth-info endpoint.
- Issue your own user tokens from your own application or identity layer.

## Architecture

For the request and cleanup flow, see [understanding.md](./understanding.md).

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
