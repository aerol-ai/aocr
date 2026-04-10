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

Important:
- `auth.jwtPublicCertificate` must contain `-----BEGIN CERTIFICATE-----`, not `-----BEGIN PUBLIC KEY-----`.
- `auth.jwtPublicKey` remains as a deprecated compatibility alias, but if you use it, it still has to contain a certificate bundle, not a raw public key.

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

## Related Docs

- [README.md](./README.md) for hosted `aocr.aerol.ai` usage
- [understanding.md](./understanding.md) for architecture and push lifecycle
