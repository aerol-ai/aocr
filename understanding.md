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
| **Reaper** | Node.js (TypeScript) | A cron job that purges expired images. |
| **Storage** | GCS (Google Cloud Storage) | Backing storage for layers and manifests. |
| **State** | Redis | Ephemeral storage for image metadata and TTL tracking. |
| **Landing Page** | Next.js | Modern, responsive frontend for user documentation. |
| **IaC** | Terraform & Ansible | Automated infrastructure provisioning and server configuration. |

## 💾 State vs. Storage: How images are tracked

A key aspect of `ttl.sh` is how it separates the actual image data from project metadata.

### 1. The "Database" for Tracking: **Redis**
Instead of a traditional relational database (like PostgreSQL), `ttl.sh` uses **Redis** to keep track of every image pushed to the registry.
- **Tracking Set**: A Redis set named `current.images` stores all active `repository:tag` strings.
- **Expiration Metadata**: For each image in that set, a Redis hash (keyed by the `repository:tag`) stores:
    - `created`: Unix timestamp of when the image was pushed.
    - `expires`: Unix timestamp of when the image should be deleted (calculated from the tag).

### 2. The "Storage" for Image Data: **GCS**
The actual image layers (blobs) and manifests are **not** stored in Redis. They are stored in **Google Cloud Storage (GCS)**.
- The Docker Registry is configured to use GCS as its storage driver.
- When the Reaper deletes an image, it sends a `DELETE` request to the registry API, which removes the manifest from GCS.

## 🧹 The Reaper: How Deletions Work

The **Reaper** is a background process that ensures nothing stays longer than its requested TTL.

1.  **Cron Schedule**: The Reaper runs every minute (`* * * * *`).
2.  **Evaluation**:
    -   It fetches all tracked images from the `current.images` Redis set.
    -   For each image, it reads the `expires` timestamp from the Redis hash.
3.  **Purge Logic**:
    -   If the current time > `expires`, the Reaper initiates a purge.
    -   It first sends a `HEAD` request to the registry to get the manifest digest (the registry's `DELETE` API requires a digest, not a tag).
    -   It then sends a `DELETE` request to `${REGISTRY_URL}/v2/${repository}/manifests/${digest}`.
    -   Finally, it cleans up Redis by removing the image from the tracking set and deleting its metadata hash.

## 🔌 Repository Hooks Configuration

The registry is configured to talk to the Hook API via `registry/config.yml`:

```yaml
notifications:
  endpoints:
    - name: registry-hooks
      url: __HOOK_URI__
      headers:
        Authorization: ["Token __HOOK_TOKEN__"]
```

## 🏗️ Deployment Flow

Deployment is automated using a combination of **Terraform** and **Ansible**:
-   **Terraform**: Provisions the underlying infrastructure (likely VMs and GCS buckets).
-   **Ansible**: Configures the OS, installs Docker, pulls the repo, and starts the services (Registry, Hooks, Reaper, Landing page).
-   **Okteto**: Used for local development and debugging of individual services (`ttl-hooks`, `ttl-reaper`).
