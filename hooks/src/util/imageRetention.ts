import { createPool } from "./database";
import { removeCachedImage } from "./redis";

const registryUrl = (process.env["REGISTRY_URL"] || "http://registry:5000").replace(/\/+$/, "");
const pool = createPool();
const manifestHeaders = {
  Accept: "application/vnd.docker.distribution.manifest.v2+json",
};

interface ReapOptions {
  repositoryIds?: string[];
  trigger?: string;
}

function normalizeRepositoryIds(repositoryIds?: string[]): string[] {
  return (repositoryIds || [])
    .map((repositoryId) => repositoryId.trim())
    .filter((repositoryId) => repositoryId.length > 0);
}

function buildRepositoryScope(repositoryIds: string[]): { query: string; values: any[]; label: string } {
  if (repositoryIds.length === 0) {
    return {
      query: "",
      values: [],
      label: "all repositories",
    };
  }

  return {
    query: "WHERE i.repository_id = ANY($1::uuid[])",
    values: [repositoryIds],
    label: `${repositoryIds.length} configured repository scope(s)`,
  };
}

export function getConfiguredRepositoryIds(): string[] {
  const rawRepositoryIds = process.env["REPOSITORY_IDS"] || process.env["REPOSITORY_ID"] || "";
  return normalizeRepositoryIds(rawRepositoryIds.split(","));
}

export async function reapObsoleteImages(options: ReapOptions = {}): Promise<number> {
  const repositoryIds = normalizeRepositoryIds(options.repositoryIds);
  const scope = buildRepositoryScope(repositoryIds);
  const trigger = options.trigger || "manual";
  const pgClient = await pool.connect();

  try {
    const staleImagesRes = await pgClient.query(`
      WITH ranked_images AS (
        SELECT
          i.id,
          i.repository_id,
          i.tag,
          r.organization,
          r.name,
          ROW_NUMBER() OVER (
            PARTITION BY i.repository_id
            ORDER BY i.last_pushed_at DESC, i.created_at DESC, i.tag DESC
          ) AS row_num
        FROM images i
        JOIN repositories r ON i.repository_id = r.id
        ${scope.query}
      )
      SELECT id, repository_id, tag, organization, name
      FROM ranked_images
      WHERE row_num > 1
      ORDER BY organization, name, tag
    `, scope.values);

    console.log(`   [${trigger}] found ${staleImagesRes.rows.length} stale image(s) across ${scope.label}`);

    for (const row of staleImagesRes.rows) {
      const image = `${row.organization}/${row.name}:${row.tag}`;
      const repoPath = `${row.organization}/${row.name}`;

      try {
        const digest = await getDigestForTag(repoPath, row.tag);
        if (digest == null) {
          await pgClient.query("DELETE FROM images WHERE id = $1", [row.id]);
          continue;
        }

        const deleteResponse = await fetch(`${registryUrl}/v2/${repoPath}/manifests/${digest}`, {
          method: "DELETE",
          headers: manifestHeaders,
        });

        if (deleteResponse.status === 202 || deleteResponse.status === 204 || deleteResponse.status === 404) {
          console.log(`purging stale image ${image}`);
          await pgClient.query("DELETE FROM images WHERE id = $1", [row.id]);
          await removeCachedImage(image);
        } else {
          console.log(`failed to delete ${image} manifest: status ${deleteResponse.status}`);
        }
      } catch (err) {
        console.log(`failed to evaluate image ${image}:`, err);
      }
    }

    return staleImagesRes.rows.length;
  } finally {
    pgClient.release();
  }
}

async function getDigestForTag(repoPath: string, tag: string): Promise<string | null> {
  const response = await fetch(`${registryUrl}/v2/${repoPath}/manifests/${tag}`, {
    method: "HEAD",
    headers: manifestHeaders,
  });

  if (response.status === 404) {
    return null;
  }

  const digestHeader = response.headers.get("docker-content-digest") || response.headers.get("etag");
  if (digestHeader == null) {
    throw new Error(`missing docker-content-digest header for ${repoPath}:${tag}`);
  }

  return String(digestHeader).replace(/"/g, "");
}
