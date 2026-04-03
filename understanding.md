# Understanding the Architecture of ttl.sh

This document provides a detailed technical deep dive into how `ttl.sh` manages ephemeral container images.

## 🔄 The Life of a `docker push`

When you run `docker push ttl.sh/my-image:5m`, the following sequence occurs:

1.  **Registry Upload**: The Docker CLI authenticates (anonymously) and uploads the image layers and manifest to the registry.
2.  **Notification Trigger**: Upon a successful push, the Docker Registry sends an HTTP POST event to the **Hook API** (`/v1/hook/registry-event`).
3.  **Parsing the Tag**: The Hook API receives the event, extracts the repository (`my-image`) and tag (`5m`).
4.  **Tracking in Redis**:
    -   The tag `5m` is parsed into a duration (in milliseconds).
    -   The Hook API adds the image (`my-image:5m`) to a Redis set called `current.images`.
    -   It also creates a Redis hash for the image with two fields: `created` and `expires` (current time + duration).

| Component | Role | Technology |
| :--- | :--- | :--- |
| **Registry** | Docker Distribution v2 | Standard OCI-compliant registry. |
| **Hook API** | Node.js (TypeScript) | Listens for registry events, parses TTLs, and handles tracking. |
| **Auth Service** | Node.js (TypeScript) | Handles Docker Token Auth and PostgreSQL sync. |
| **Reaper** | Node.js (TypeScript) | A cron job that purges expired images. |
| **Storage** | GCS (Google Cloud Storage) | Backing storage for layers and manifests. |
| **State (Metadata)** | PostgreSQL | Persistent storage for users, repositories, and image metadata. |
| **Cache (Legacy)** | Redis | Ephemeral storage for hook events and legacy tracking. |

## 💾 State vs. Storage: How images are tracked

`ttl.sh` separates the actual image data from project metadata for efficiency and persistence.

### 1. The "Database" for Tracking: **PostgreSQL**
The system uses **PostgreSQL** as the primary source of truth for repository and user metadata.
- **Users**: Tracks authenticated users validated by the third-party service.
- **Repositories**: Organizes images into organizations and repositories linked to users.
- **Images**: Tracks specific tags, their creation time, and their calculated expiration timestamp.

### 2. The "Storage" for Image Data: **GCS**
The actual image layers (blobs) and manifests are stored in **Google Cloud Storage (GCS)**.
- The Docker Registry is configured to use GCS as its storage driver.
- When an image is deleted (via the Reaper), the registry API removes the manifest and associated blobs from GCS.

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
