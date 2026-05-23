# Self-Hosting aocr

This guide is for operators who want to deploy their own aocr instance. If you only want to use the hosted registry at `aocr.aerol.ai`, follow the usage instructions in [README.md](./README.md).

## What You Need

- A registry hostname such as `registry.example.com`
- An upstream auth-info endpoint that can validate your user token
- A PEM private key for the auth service to sign registry JWTs
- A PEM certificate bundle for the registry to verify those JWTs
- PostgreSQL
- Redis
- S3-compatible object storage
- Kubernetes plus Helm, or Docker Compose for local development

## User Login Model

End-user registry access works like this:

1. Your application issues a user token.
2. The user runs `docker login` or `helm registry login` against your registry host.
3. The user passes their app identity as the login name.
4. The user passes their token as the password.
5. The auth service validates that token against your auth-info endpoint.
6. If validation succeeds, the auth service issues the registry bearer token used for push or pull.

The login name does not need to be secret, but it must match the validated user profile's `id`, `username`, or `email`.

The webhook secret is separate:

- `hooks.token` is not an end-user credential.
- It is only used internally when the registry sends push notifications to the hooks service.

## Auth Validation Modes

The auth service supports two validation modes:

1. API validation.
  - Configure `auth.validationServiceUrl`.
  - The auth service calls your upstream `/api/auth/info` endpoint and uses its response as the user profile.

2. Static PAT validation.
  - Configure `auth.pat.token` for one PAT, or `auth.pat.tokens` for multiple PATs.
  - The auth service compares the presented Docker password against the configured PAT set locally and skips the upstream API call when it matches.
  - The static PAT path uses an internal fixed subject and skips auth-time Postgres sync.
  - The presented Docker username is ignored in this mode.

If you configure both modes, the auth service uses this order:

1. Check whether the presented token matches the configured static PAT.
2. If it matches, validate locally.
3. If it does not match, fall back to `auth.validationServiceUrl`.

## Kubernetes With Helm

Example install:

```bash
helm install aocr oci://ghcr.io/aerol-ai/charts/aocr \
  --namespace aocr-system \
  --create-namespace \
  --version <published-chart-version> \
  --set image.repository="ghcr.io/aerol-ai" \
  --set image.tag="latest" \
  --set global.domain="registry.example.com" \
  --set postgres.password="CHANGE_ME_POSTGRES_PASSWORD" \
  --set redis.password="CHANGE_ME_REDIS_PASSWORD" \
  --set hooks.token="CHANGE_ME_HOOK_SHARED_SECRET" \
  --set registry.replregSecret="CHANGE_ME_REGISTRY_HTTP_SECRET" \
  --set registry.s3.region="us-east-1" \
  --set registry.s3.bucket="aocr" \
  --set registry.s3.endpoint="https://s3.example.com" \
  --set registry.s3.accessKey="CHANGE_ME_S3_ACCESS_KEY" \
  --set registry.s3.secretKey="CHANGE_ME_S3_SECRET_KEY" \
  --set auth.validationServiceUrl="https://app.example.com/api/auth/info" \
  --set-file auth.jwtPrivateKey="/path/to/jwt-private.pem" \
  --set-file auth.jwtPublicCertificate="/path/to/jwt-public.crt"
```

Required values and what they do:
- `global.domain`: public registry hostname used by clients and by the registry token auth realm.
- `postgres.password`: password used by the in-cluster PostgreSQL instance.
- `redis.password`: password used by the in-cluster Redis instance.
- `hooks.token`: shared secret used by the registry notification webhook.
- `registry.replregSecret`: Docker Distribution HTTP secret. This should be a stable random string for the registry instance.
- `registry.s3.accessKey` and `registry.s3.secretKey`: credentials for the S3-compatible object store where image layers and manifests are stored.
- `auth.validationServiceUrl`: upstream auth-info endpoint that validates user tokens.
- `auth.jwtPrivateKey`: private key used by the auth service to sign Docker registry bearer tokens.
- `auth.jwtPublicCertificate`: PEM-encoded X.509 certificate bundle mounted into the registry so it can verify the JWTs signed by `auth.jwtPrivateKey`.
- `auth.pat.token`: a single static PAT value matched against the presented Docker password.
- `auth.pat.tokens`: multiple static PAT values, each treated as a local fast-path match.

Important:
- `auth.jwtPublicCertificate` must contain `-----BEGIN CERTIFICATE-----`, not `-----BEGIN PUBLIC KEY-----`.
- `auth.jwtPublicKey` remains as a deprecated compatibility alias, but if you use it, it still has to contain a certificate bundle, not a raw public key.
- If you want PAT-only mode, set `auth.pat.token` or `auth.pat.tokens` and leave `auth.validationServiceUrl` empty.
- If you want mixed mode, configure both `auth.pat.*` and `auth.validationServiceUrl`; PAT matches stay local and all other tokens fall back to the API.

Why the JWT key pair exists:
- The auth service issues the bearer token that Docker or Helm uses after login.
- The registry must verify that token before allowing push or pull.
- The private key stays only with the auth service.
- The matching certificate is mounted into the registry as `auth.crt` and referenced by the registry token configuration.

If you prefer, put the same values into a dedicated production values file and install with:

```bash
helm install aocr oci://ghcr.io/aerol-ai/charts/aocr \
  --namespace aocr-system \
  --create-namespace \
  --version <published-chart-version> \
  -f values-prod.yaml
```

## End-User Commands For Your Own Deployment

After you issue your own app token and choose a registry hostname, your users can log in like this:

```bash
export AOCR_LOGIN="your-username-or-email"
export AOCR_TOKEN="your-token"

echo "$AOCR_TOKEN" | docker login registry.example.com -u "$AOCR_LOGIN" --password-stdin
docker tag my-image registry.example.com/aocr/my-image:main
docker push registry.example.com/aocr/my-image:main
docker pull registry.example.com/aocr/my-image:main
```

Helm chart usage:

```bash
echo "$AOCR_TOKEN" | helm registry login registry.example.com -u "$AOCR_LOGIN" --password-stdin
helm package ./my-chart
helm push my-chart-0.1.0.tgz oci://registry.example.com/charts
helm install my-release oci://registry.example.com/charts/my-chart --version 0.1.0
```

## Docker Compose

For local development only:

```bash
cp .env.example .env
docker compose up -d
```

Notes:
- `REPOSITORY_IDS` is optional. Leave it empty to sweep all repositories, or set one or more UUIDs to limit the cron job scope.
- `VALIDATION_SERVICE_URL` should point to the upstream auth-info endpoint that accepts `Authorization: Bearer <your-token>` and returns user identity details.
- End users do not call `VALIDATION_SERVICE_URL` directly. They log in to the registry with the token your application gave them.

## Retention Policies

Phase 1 retention is tag-driven and supports age-based expiry.

Examples:

```bash
docker push registry.example.com/aocr/my-image:main
docker push registry.example.com/aocr/my-image:main--ttl-7d
docker push registry.example.com/aocr/my-image:main--ttl-1month
```

Behavior:

- plain tags like `main` continue to use latest-only cleanup
- `--ttl-*` tags remain available until their age-based TTL expires
- supported suffixes are documented in [RETENTION.md](./RETENTION.md)

Upgrade note:

- New installs pick up the updated schema automatically.
- Existing installs should run [db/migrate-retention-policies.sql](./db/migrate-retention-policies.sql) before deploying the updated hooks and reaper images.

## Metrics

The chart now exposes scrapeable metrics for the pull-path services:

```yaml
metrics:
  enabled: true
```

- `auth`: `/metrics` on port `8080`
- `hooks`: `/metrics` on port `8000`
- `registry`: `/metrics` on debug port `5001`

For Docker Compose, the registry debug port is no longer published by default. If you want local host access to `http://localhost:5001/metrics`, run Compose with the metrics override file:

```bash
METRICS_ENABLED=true docker compose -f docker-compose.yaml -f docker-compose.metrics.yaml up
```

When metrics are enabled, the auth, hooks, and registry pods and services are annotated with `prometheus.io/scrape`, `prometheus.io/path`, and `prometheus.io/port`.

If you use the Prometheus Operator, you can also enable ServiceMonitor resources:

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
```

You can also enable bundled Prometheus alert rules for the auth and hooks metrics:

```yaml
metrics:
  enabled: true
  prometheusRule:
    enabled: true
```

An importable Grafana dashboard is available at [deploy/grafana/aocr-observability-dashboard.json](./deploy/grafana/aocr-observability-dashboard.json).

For the full metrics matrix and the key metric names per service, see [OBSERVABILITY.md](./OBSERVABILITY.md).

## Related Docs

- [README.md](./README.md) for hosted `aocr.aerol.ai` usage
- [OBSERVABILITY.md](./OBSERVABILITY.md) for metrics endpoints and metric coverage
- [understanding.md](./understanding.md) for architecture and push lifecycle
