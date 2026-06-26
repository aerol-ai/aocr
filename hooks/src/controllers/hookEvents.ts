import type { Pool } from "pg";
import { reapObsoleteImages } from "../util/imageRetention";
import { cachePushedImage } from "../util/redis";
import { inferredProvenance, parseTagRetention } from "../util/tagRetention";
import {
  elapsedSecondsSince,
  markSuccessfulReap,
  markSuccessfulWebhook,
  recordImmediateReap,
  recordPostgresSync,
  recordRedisCache,
  recordRegistryEvent,
  recordRegistryEventBatch,
  recordRepositoriesScheduledForReap,
} from "../metrics";

export const UPDATE_LAST_PULLED_AT_SQL = `
  UPDATE images i
  SET last_pulled_at = CURRENT_TIMESTAMP
  FROM repositories r
  WHERE i.repository_id = r.id
    AND r.organization = $1
    AND r.name = $2
    AND i.tag = $3
    AND (i.last_pulled_at IS NULL OR i.last_pulled_at < CURRENT_TIMESTAMP - INTERVAL '1 hour')
`;

export const DELETE_MANIFEST_SQL = `
  DELETE FROM images i
  USING repositories r
  WHERE i.repository_id = r.id
    AND r.organization = $1
    AND r.name = $2
    AND i.manifest_digest = $3
`;

export function isManifestPullMediaType(mediaType: unknown): boolean {
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    return false;
  }
  return mediaType.includes("manifest") || mediaType.includes("image.index");
}

export interface RegistryEventBody {
  events?: Array<{
    action?: string;
    target?: {
      repository?: string;
      tag?: string;
      digest?: string;
      mediaType?: string;
    };
  }>;
}

export interface ProcessRegistryEventsOptions {
  pgPool: Pool;
  reap?: typeof reapObsoleteImages;
  cachePush?: typeof cachePushedImage;
}

export async function processRegistryEvents(
  body: RegistryEventBody,
  options: ProcessRegistryEventsOptions,
): Promise<void> {
  const pgPool = options.pgPool;
  const reap = options.reap ?? reapObsoleteImages;
  const cachePush = options.cachePush ?? cachePushedImage;

  recordRegistryEventBatch(Array.isArray(body?.events) ? body.events.length : 0);

  const repositoriesToReap = new Set<string>();

  for (const event of body.events || []) {
    recordRegistryEvent(event.action || "unknown");

    if (event.action === "push") {
      const image = event.target?.repository;
      const tag = event.target?.tag;
      const manifestDigest = typeof event?.target?.digest === "string" ? event.target.digest : null;

      if (!image || !tag) {
        continue;
      }

      const imageWithTag = `${image}:${tag}`;
      const pushedAt = new Date();
      const retention = parseTagRetention(tag, pushedAt);

      const redisStartedAt = process.hrtime.bigint();
      try {
        await cachePush(imageWithTag, pushedAt);
        recordRedisCache("success", elapsedSecondsSince(redisStartedAt));
      } catch (err) {
        recordRedisCache("error", elapsedSecondsSince(redisStartedAt));
        console.warn(`hook: redis cache write failed for ${imageWithTag} — continuing (Postgres remains the source of truth):`, err);
      }

      try {
        const parsed = inferredProvenance(image);
        if (parsed) {
          const { organization, name, provenance, clusterId, upstreamRef } = parsed;
          const postgresStartedAt = process.hrtime.bigint();
          const pgClient = await pgPool.connect();
          try {
            await pgClient.query("BEGIN");

            const repoRes = await pgClient.query(
              "INSERT INTO repositories (organization, name) VALUES ($1, $2) ON CONFLICT (organization, name) DO UPDATE SET name = $2 RETURNING id",
              [organization, name],
            );
            const repoId = repoRes.rows[0].id;

            await pgClient.query(
              `INSERT INTO images (
                  repository_id,
                  tag,
                  last_pushed_at,
                  retention_mode,
                  retention_value_seconds,
                  expires_at,
                  raw_retention_suffix,
                  manifest_digest,
                  provenance,
                  cluster_id,
                  upstream_ref
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (repository_id, tag) DO UPDATE SET
                  last_pushed_at = EXCLUDED.last_pushed_at,
                  retention_mode = EXCLUDED.retention_mode,
                  retention_value_seconds = EXCLUDED.retention_value_seconds,
                  expires_at = EXCLUDED.expires_at,
                  raw_retention_suffix = EXCLUDED.raw_retention_suffix,
                  manifest_digest = COALESCE(EXCLUDED.manifest_digest, images.manifest_digest),
                  provenance = EXCLUDED.provenance,
                  cluster_id = COALESCE(EXCLUDED.cluster_id, images.cluster_id),
                  upstream_ref = COALESCE(EXCLUDED.upstream_ref, images.upstream_ref)`,
              [
                repoId,
                tag,
                pushedAt,
                retention.retentionMode,
                retention.retentionValueSeconds,
                retention.expiresAt,
                retention.rawRetentionSuffix,
                manifestDigest,
                provenance,
                clusterId,
                upstreamRef,
              ],
            );

            await pgClient.query("COMMIT");
            recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
            repositoriesToReap.add(repoId);
          } catch (err) {
            await pgClient.query("ROLLBACK");
            recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
            console.error("Error syncing to Postgres:", err);
          } finally {
            pgClient.release();
          }
        }
      } catch (err) {
        console.error("Error processing org/repo metadata:", err);
      }
    } else if (event.action === "delete") {
      const image = event.target?.repository;
      const digest = typeof event?.target?.digest === "string" ? event.target.digest : null;

      if (!image || !digest) {
        continue;
      }

      try {
        const parsed = inferredProvenance(image);
        if (parsed) {
          const { organization, name } = parsed;
          const postgresStartedAt = process.hrtime.bigint();
          const pgClient = await pgPool.connect();
          try {
            await pgClient.query(DELETE_MANIFEST_SQL, [organization, name, digest]);
            recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
          } catch (err) {
            recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
            console.error("Error syncing delete to Postgres:", err);
          } finally {
            pgClient.release();
          }
        }
      } catch (err) {
        console.error("Error processing delete metadata:", err);
      }
    } else if (event.action === "pull") {
      const image = event.target?.repository;
      const tag = event.target?.tag;
      const mediaType = event.target?.mediaType;

      if (!image || !tag || !isManifestPullMediaType(mediaType)) {
        console.log(`hook: pull event skipped repo=${image} tag=${tag} mediaType=${mediaType} (missing tag, repo, or non-manifest-class mediaType — blob pulls and digest-only pulls do not fire last_pulled_at updates)`);
        continue;
      }

      try {
        const parsed = inferredProvenance(image);
        if (parsed) {
          const { organization, name } = parsed;
          const postgresStartedAt = process.hrtime.bigint();
          const pgClient = await pgPool.connect();
          try {
            const result = await pgClient.query(UPDATE_LAST_PULLED_AT_SQL, [organization, name, tag]);
            console.log(`hook: pull update org=${organization} name=${name} tag=${tag} rows_updated=${result.rowCount} (0 = no matching row OR last_pulled_at refreshed within the past hour)`);
            recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
          } catch (err) {
            recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
            console.error("Error syncing pull to Postgres:", err);
          } finally {
            pgClient.release();
          }
        } else {
          console.log(`hook: pull event repo=${image} did not parse as a known provenance — skipping`);
        }
      } catch (err) {
        console.error("Error processing pull metadata:", err);
      }
    }
  }

  recordRepositoriesScheduledForReap(repositoriesToReap.size);

  for (const repositoryId of repositoriesToReap) {
    const reapStartedAt = process.hrtime.bigint();
    try {
      await reap({
        repositoryIds: [repositoryId],
        trigger: "push",
      }, pgPool);
      recordImmediateReap("success", elapsedSecondsSince(reapStartedAt));
      markSuccessfulReap();
    } catch (err) {
      recordImmediateReap("error", elapsedSecondsSince(reapStartedAt));
      console.error(`Error reaping stale images for repository ${repositoryId}:`, err);
    }
  }

  markSuccessfulWebhook();
}
