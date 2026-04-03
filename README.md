[![Develop on Okteto](https://okteto.com/develop-okteto.svg)](https://replicated.okteto.dev/deploy?repository=https://github.com/replicatedhq/ttl.sh&branch=main)

# ttl.sh

## An ephemeral container registry for CI workflows.

`ttl.sh` is an anonymous, expiring Docker container registry. It allows you to push images without authentication and have them automatically deleted after a specified duration.

## 🏗️ Architecture Overview

The system consists of four main components:
1.  **Container Registry**: A standard Docker Distribution (v2) registry configured with a GCS backend and HTTP hooks.
2.  **Hook API**: A Node.js service that receives notifications from the registry on every `push` event. It parses the image tag for a TTL (Time To Live) and tracks it.
3.  **The Reaper**: A background cron job that periodically checks for expired images and purges them from the registry.
4.  **Web Frontend**: A Next.js application providing a landing page with usage instructions and features.

## 🛠️ Tools & Technologies

-   **Backend**: Node.js, TypeScript, Express
-   **Frontend**: Next.js, React, Tailwind CSS
-   **Registry**: Docker Distribution v2
-   **State**: Redis (for tracking image expiration)
-   **Storage**: Google Cloud Storage (GCS)
-   **Infrastructure**: Terraform, Ansible
-   **Development**: Okteto

## 🚀 Quick Start

Push an image with a specific TTL (e.g., 5 minutes):
```bash
docker tag my-image ttl.sh/my-image:5m
docker push ttl.sh/my-image:5m
```

The image will be available to pull for 5 minutes and then automatically deleted.

- **Default TTL**: 24h
- **Max TTL**: 24h

For a deep dive into how `ttl.sh` works internally, see [understanding.md](./understanding.md).

# Deployment

`ttl.sh` is designed to be deployed using **Kubernetes (via Helm)** or **Docker Compose**.

## ☸️ Kubernetes (Helm)

The recommended way to deploy `ttl.sh` in production is using the provided Helm chart.

```bash
cd helm/ttlsh
helm install my-ttlsh . --values values.yaml
```

> [!IMPORTANT]
> Ensure you configure the required secrets (PostgreSQL password, JWT keys, GCS keys) in `values.yaml` or via `--set`.

## 🐳 Docker Compose

For local development or simple deployments, use Docker Compose:

```bash
docker-compose up -d
```

## 🛠️ Development

Each service (`auth`, `hooks`, `web`) can be built and run locally using Docker or their respective package managers.

- **Frontend**: `cd web && npm run dev`
- **Hooks**: `cd hooks && npm start`
- **Auth**: `cd auth && npm start`
