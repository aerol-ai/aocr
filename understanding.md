# 🧠 Understanding aocr (aerol.ai)

An in-depth look at the architecture, data flow, and components of the authenticated registry system.

## 🔄 The Life of a `docker push`

When you run `docker push aerol.ai/aocr/my-image:5m`, the following sequence occurs:

1.  **Registry Upload**: The Docker CLI authenticates (via token) and uploads the image layers and manifest to the registry.
2.  **Notification Trigger**: Upon a successful push, the Docker Registry sends an HTTP POST event to the **Hook API** (`/v1/hook/registry-event`).
3.  **Parsing the Tag**: The Hook API receives the event, extracts the repository (`my-image`) and tag (`5m`).
4.  **Tracking in PostgreSQL**:
    -   The tag `5m` is parsed into a duration.
    -   The Hook API updates the **PostgreSQL** `images` table with the metadata and expiration.

| Component | Role | Technology |
| :--- | :--- | :--- |
| **Registry** | Docker Distribution v2 | Standard OCI-compliant registry. |
| **Hook API** | Node.js (TypeScript) | Listens for registry events, parses TTLs, and handles tracking. |
| **Auth Service** | Node.js (TypeScript) | Handles Docker Token Auth and PostgreSQL sync. |
| **Reaper** | Node.js (TypeScript) | A cron job that purges expired images. |
| **Storage** | S3 / Minio | Backing storage for layers and manifests. |
| **State (Metadata)** | PostgreSQL | Persistent storage for users, repositories, and image metadata. |
| **Cache (Legacy)** | Redis | Ephemeral storage for hook events and legacy caching. |

## 💾 State vs. Storage: How images are tracked

`ttl.sh` separates the actual image data from project metadata for efficiency and persistence.

### 1. The "Database" for Tracking: **PostgreSQL**
The system uses **PostgreSQL** as the primary source of truth for repository and user metadata.
- **Users**: Tracks authenticated users validated by the third-party service.
- **Repositories**: Organizes images into organizations and repositories linked to users.
- **Images**: Tracks specific tags, their creation time, and their calculated expiration timestamp.

### 2. The "Storage" for Image Data: **S3 / Minio**
The actual image layers (blobs) and manifests are stored in an **S3-compatible storage** (like AWS S3 or Minio).
- The Docker Registry is configured to use the `s3` storage driver.
- When an image is deleted (via the Reaper), the registry API removes the manifest and associated blobs from the storage bucket.

## 🧹 The Reaper: How Deletions Work

The **Reaper** ensures images are purged accurately according to their TTL.

1.  **Cron Schedule**: Runs every minute (`* * * * *`).
2.  **Evaluation**: Queries the **PostgreSQL** `images` table for records where `expires_at <= NOW()`.
3.  **Purge Logic**:
    -   Requests the manifest digest from the registry.
    -   Issues a `DELETE` request to the registry API for that digest.
    -   Upon success, removes the metadata record from PostgreSQL.

## 🏗️ Deployment Flow

`ttl.sh` supports two primary deployment methods:

-   **Kubernetes (Helm)**: The recommended production path. The provided Helm chart manages all services, configures PostgreSQL/Redis, and handles secret management for JWT and GCS keys.
-   **Docker Compose**: Ideal for local development and standalone setups.
