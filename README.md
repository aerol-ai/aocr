# 🚀 aerol.ai / aocr

**aocr** (Authenticated OCI Container Registry) is a high-performance, authenticated Docker registry for the **aerol.ai** organization. It is designed to be deployed on Kubernetes via Helm, with automatic image tracking in PostgreSQL and storage in S3/Minio.

## ✨ Key Features
-   **🔐 Authenticated Access**: All push/pull operations require a valid token validated against a central service.
-   **📊 PostgreSQL Metadata**: Tracks users, organizations, repositories, and images.
-   **📦 S3-Compatible Storage**: Supports AWS S3, Minio, and other S3-compatible backends.
-   **🧹 Automatic Cleanup**: Includes a "Reaper" service to purge expired images.
-   **☸️ Kubernetes Native**: Optimized for deployment via Helm.

-   **Storage**: S3 / Minio
-   **Infrastructure**: Helm (Kubernetes), Docker Compose

## 🚀 Quick Start

Push an image with a specific TTL (e.g., 5 minutes):
```bash
docker tag my-image aerol.ai/aocr/my-image:5m
docker push aerol.ai/aocr/my-image:5m
```

The image will be available to pull for 5 minutes (subject to authentication) and then automatically deleted.

- **Default TTL**: 24h
- **Max TTL**: 24h

For a deep dive into how **aocr** works internally, see [understanding.md](./understanding.md).

# Deployment

**aocr** is designed to be deployed using **Kubernetes (via Helm)** or **Docker Compose**.

## ☸️ Kubernetes (Helm)

The recommended way to deploy **aocr** in production is using the provided Helm chart.

```bash
cd helm/aocr
helm install my-aocr . --values values.yaml
```

> [!IMPORTANT]
> Ensure you configure the required secrets (PostgreSQL password, JWT keys, and **S3/Minio credentials**) in `values.yaml` or via `--set`.

## 🐳 Docker Compose

For local development or simple deployments, use Docker Compose. This setup includes a **Minio** container to simulate S3 storage locally.

```bash
docker-compose up -d
```

## 🛠️ Development

Each service (`auth`, `hooks`, `web`) can be built and run locally using Docker or their respective package managers.

- **Frontend**: `cd web && npm run dev`
- **Hooks**: `cd hooks && npm start`
- **Auth**: `cd auth && npm start`
