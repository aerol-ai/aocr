import { createPool } from "./database";
import { removeCachedImage } from "./redis";

const registryUrl = (process.env["REGISTRY_URL"] || "http://registry:5000").replace(/\/+$/, "");
const pool = createPool();
const manifestHeaders = {
  Accept: "application/vnd.docker.distribution.manifest.v2+json",
};

const DEFAULT_MIRROR_IDLE_SECONDS = 30 * 24 * 60 * 60;

function parseMirrorDefaultIdleSeconds(): number {
  const raw = (process.env["MIRROR_DEFAULT_IDLE_SECONDS"] || "").trim();
  if (raw.length === 0) {
    return DEFAULT_MIRROR_IDLE_SECONDS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MIRROR_IDLE_SECONDS;
  }

  return Math.floor(parsed);
}

export function parseMirrorUpstreamRetentionMap(raw?: string): Record<string, number> {
  const source = (raw == null ? process.env["MIRROR_UPSTREAM_RETENTION_JSON"] : raw) || "";
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return {};
  }

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const out: Record<string, number> = {};
  for (const [upstream, value] of Object.entries(parsed)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      continue;
    }
    out[upstream] = Math.floor(seconds);
  }
  return out;
}

interface ReapOptions {
  repositoryIds?: string[];
  trigger?: string;
}

interface ReapCandidateRow {
  id: string;
  repository_id: string;
  tag: string;
  organization: string;
  name: string;
  manifest_digest: string | null;
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
  const mirrorDefaultIdleSeconds = parseMirrorDefaultIdleSeconds();
  const mirrorOverrides = parseMirrorUpstreamRetentionMap();
  const mirrorOverrideUpstreams = Object.keys(mirrorOverrides);
  const mirrorOverrideSeconds = mirrorOverrideUpstreams.map((upstream) => mirrorOverrides[upstream]);
  const pgClient = await pool.connect();

  try {
    const scopeValueCount = scope.values.length;
    const mirrorDefaultParam = `$${scopeValueCount + 1}`;
    const mirrorUpstreamArrayParam = `$${scopeValueCount + 2}`;
    const mirrorSecondsArrayParam = `$${scopeValueCount + 3}`;
    const mirrorParamValues = [
      mirrorDefaultIdleSeconds,
      mirrorOverrideUpstreams,
      mirrorOverrideSeconds,
    ];
    const staleImagesRes = await pgClient.query<ReapCandidateRow>(`
      WITH mirror_overrides AS (
        SELECT
          UNNEST(${mirrorUpstreamArrayParam}::text[]) AS upstream_prefix,
          UNNEST(${mirrorSecondsArrayParam}::bigint[]) AS retention_seconds
      ),
      mirror_resolved_retention AS (
        SELECT
          i.id,
          COALESCE(
            (
              SELECT mo.retention_seconds
              FROM mirror_overrides mo
              WHERE i.upstream_ref IS NOT NULL
                AND i.upstream_ref LIKE mo.upstream_prefix || '%'
              ORDER BY LENGTH(mo.upstream_prefix) DESC
              LIMIT 1
            ),
            ${mirrorDefaultParam}::bigint
          ) AS retention_seconds
        FROM images i
        WHERE i.provenance = 'mirror'
      ),
      keep_latest_images AS (
        SELECT
          i.id,
          i.repository_id,
          i.tag,
          i.manifest_digest,
          r.organization,
          r.name,
          ROW_NUMBER() OVER (
            PARTITION BY i.repository_id
            ORDER BY i.last_pushed_at DESC, i.created_at DESC, i.tag DESC
          ) AS row_num
        FROM images i
        JOIN repositories r ON i.repository_id = r.id
        ${scope.query}${scope.query.length > 0 ? " AND" : " WHERE"} i.retention_mode = 'keep-latest'
          AND i.provenance <> 'mirror'
      ),
      expired_ttl_images AS (
        -- TTL applies uniformly across provenance. Mirror tags carrying an explicit
        -- --ttl-* suffix should expire on time too, so this CTE no longer excludes mirror.
        -- expired_mirror_idle_images excludes retention_mode = 'ttl' so there is no overlap.
        SELECT
          i.id,
          i.repository_id,
          i.tag,
          i.manifest_digest,
          r.organization,
          r.name
        FROM images i
        JOIN repositories r ON i.repository_id = r.id
        ${scope.query}${scope.query.length > 0 ? " AND" : " WHERE"} i.retention_mode = 'ttl'
          AND i.expires_at IS NOT NULL
          AND i.expires_at <= CURRENT_TIMESTAMP
      ),
      expired_idle_images AS (
        -- Idle expiry must fire even when last_pulled_at is null (the tag has never
        -- been pulled — the maximum case of "idle"). Anchor the clock to the most
        -- recent of last_pulled_at, last_pushed_at, created_at so the row's own
        -- timestamps always provide a start time.
        SELECT
          i.id,
          i.repository_id,
          i.tag,
          i.manifest_digest,
          r.organization,
          r.name
        FROM images i
        JOIN repositories r ON i.repository_id = r.id
        ${scope.query}${scope.query.length > 0 ? " AND" : " WHERE"} i.retention_mode = 'idle'
          AND i.retention_value_seconds IS NOT NULL
          AND COALESCE(i.last_pulled_at, i.last_pushed_at, i.created_at)
              + (i.retention_value_seconds || ' seconds')::interval <= CURRENT_TIMESTAMP
          AND i.provenance <> 'mirror'
      ),
      expired_mirror_idle_images AS (
        -- Prefer the row's own retention_value_seconds (set when a mirror tag carries
        -- an explicit --idle-* suffix) over the upstream-default retention from
        -- mirror_resolved_retention. Most mirror tags have no suffix → retention_mode
        -- stays 'keep-latest' and retention_value_seconds is null, in which case we
        -- fall back to the upstream default via COALESCE.
        SELECT
          i.id,
          i.repository_id,
          i.tag,
          i.manifest_digest,
          r.organization,
          r.name
        FROM images i
        JOIN repositories r ON i.repository_id = r.id
        JOIN mirror_resolved_retention mrr ON mrr.id = i.id
        ${scope.query}${scope.query.length > 0 ? " AND" : " WHERE"} i.provenance = 'mirror'
          AND i.retention_mode <> 'ttl'
          AND COALESCE(i.last_pulled_at, i.last_pushed_at, i.created_at) IS NOT NULL
          AND COALESCE(i.last_pulled_at, i.last_pushed_at, i.created_at)
              + (COALESCE(i.retention_value_seconds, mrr.retention_seconds) || ' seconds')::interval <= CURRENT_TIMESTAMP
      )
      SELECT id, repository_id, tag, organization, name, manifest_digest
      FROM keep_latest_images
      WHERE row_num > 1
      UNION ALL
      SELECT id, repository_id, tag, organization, name, manifest_digest
      FROM expired_ttl_images
      UNION ALL
      SELECT id, repository_id, tag, organization, name, manifest_digest
      FROM expired_idle_images
      UNION ALL
      SELECT id, repository_id, tag, organization, name, manifest_digest
      FROM expired_mirror_idle_images
      ORDER BY organization, name, tag
      LIMIT 500
    `, [...scope.values, ...mirrorParamValues]);

    console.log(`   [${trigger}] found ${staleImagesRes.rows.length} stale image(s) across ${scope.label}`);

    for (const row of staleImagesRes.rows) {
      const image = `${row.organization}/${row.name}:${row.tag}`;
      const repoPath = `${row.organization}/${row.name}`;

      try {
        const digest = row.manifest_digest || await getDigestForTag(repoPath, row.tag);
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
