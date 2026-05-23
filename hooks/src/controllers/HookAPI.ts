import * as Express from "express";
import {
  Controller,
  Post,
  Res,
  HeaderParams,
  BodyParams,
  Req} from "ts-express-decorators";
import { createPool } from "../util/database";
import { reapObsoleteImages } from "../util/imageRetention";
import { cachePushedImage } from "../util/redis";
import { inferredProvenance, parseTagRetention } from "../util/tagRetention";
import {
  bindMetricsPool,
  elapsedSecondsSince,
  markSuccessfulReap,
  markSuccessfulWebhook,
  recordImmediateReap,
  recordPostgresSync,
  recordRedisCache,
  recordRegistryEvent,
  recordRegistryEventBatch,
  recordRepositoriesScheduledForReap,
  recordWebhookAuthorization,
} from "../metrics";

interface ErrorResponse {
  error: any;
}

const pool = createPool();
bindMetricsPool(pool);

// Update last_pulled_at on every pull, regardless of retention_mode. Mirror images
// are stored as keep-latest but the reaper's mirror-idle expiry in imageRetention.ts
// reads COALESCE(last_pulled_at, last_pushed_at, created_at) to decide if a cached
// upstream image is still warm — filtering by retention_mode = 'idle' here meant
// mirror entries aged out based on first-cache time instead of actual usage.
// The hourly debounce prevents write storms when a popular tag is pulled repeatedly.
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

// Drop the Postgres row for a manifest the registry has reported as deleted.
// Match by manifest_digest, not tag, because the registry emits one delete event
// per manifest digest (tag-less). A single digest may be referenced by multiple
// tags within the same repository — they all go away together when the manifest
// is gone, so deleting every matching row is correct.
export const DELETE_MANIFEST_SQL = `
  DELETE FROM images i
  USING repositories r
  WHERE i.repository_id = r.id
    AND r.organization = $1
    AND r.name = $2
    AND i.manifest_digest = $3
`;

// A pull event counts as "the user pulled this tag" only when the mediaType is a
// manifest-class media type (so we ignore blob GETs, which also fire pull events).
// Docker schema v1/v2 and OCI image manifest all contain the literal "manifest",
// but the OCI spec renamed manifest-list -> image.index — application/vnd.oci.image.index.v1+json
// does NOT contain "manifest". A multi-arch docker pull (e.g. rust:slim-trixie)
// starts with HEAD/GET on the image.index; if that's filtered out, multi-arch
// pulls never update last_pulled_at and the row looks like it was never pulled.
export function isManifestPullMediaType(mediaType: unknown): boolean {
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    return false;
  }
  return mediaType.includes("manifest") || mediaType.includes("image.index");
}

@Controller("/v1/hook")
export class HookAPI {
  /**
   * /v1/exec handler
   *
   * @param request
   * @param response
   * @returns {{id: any, name: string}}
   */
  @Post("/registry-event")
  public async hook(
    @Res() response: Express.Response,
    @Req() request: Express.Request,
    @HeaderParams("Authorization") authorization: string,
    @BodyParams("") body: any,
  ): Promise<ErrorResponse | {}> {
    if (authorization !== `Token ${process.env["HOOK_TOKEN"]}`) {
      recordWebhookAuthorization("rejected");
      response.status(401);
      return {};
    }

    recordWebhookAuthorization("accepted");
    recordRegistryEventBatch(Array.isArray(body?.events) ? body.events.length : 0);

    const repositoriesToReap = new Set<string>();

    for (const event of body.events) {
      recordRegistryEvent(event.action || "unknown");

      if (event.action === "push") {
        const image = event.target.repository;
        const tag = event.target.tag;
        const manifestDigest = typeof event?.target?.digest === "string" ? event.target.digest : null;

        if (!image || !tag) {
          continue;
        }

        const imageWithTag = `${image}:${tag}`;
        const pushedAt = new Date();
        const retention = parseTagRetention(tag, pushedAt);

        // Redis (legacy/cache)
        const redisStartedAt = process.hrtime.bigint();
        try {
          await cachePushedImage(imageWithTag, pushedAt);
          recordRedisCache("success", elapsedSecondsSince(redisStartedAt));
        } catch (err) {
          recordRedisCache("error", elapsedSecondsSince(redisStartedAt));
          throw err;
        }

        // Postgres metadata store
        try {
          const parsed = inferredProvenance(image);
          if (parsed) {
            const { organization, name, provenance, clusterId, upstreamRef } = parsed;
            const postgresStartedAt = process.hrtime.bigint();
            const pgClient = await pool.connect();
            try {
              await pgClient.query('BEGIN');

              const repoRes = await pgClient.query(
                'INSERT INTO repositories (organization, name) VALUES ($1, $2) ON CONFLICT (organization, name) DO UPDATE SET name = $2 RETURNING id',
                [organization, name]
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
                ]
              );

              await pgClient.query('COMMIT');
              recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
              repositoriesToReap.add(repoId);
            } catch (err) {
              await pgClient.query('ROLLBACK');
              recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
              console.error('Error syncing to Postgres:', err);
            } finally {
              pgClient.release();
            }
          }
        } catch (err) {
          console.error('Error processing org/repo metadata:', err);
        }
      } else if (event.action === "delete") {
        const image = event.target.repository;
        const digest = typeof event?.target?.digest === "string" ? event.target.digest : null;

        if (!image || !digest) {
          continue;
        }

        try {
          const parsed = inferredProvenance(image);
          if (parsed) {
            const { organization, name } = parsed;
            const postgresStartedAt = process.hrtime.bigint();
            const pgClient = await pool.connect();
            try {
              await pgClient.query(DELETE_MANIFEST_SQL, [organization, name, digest]);
              recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
            } catch (err) {
              recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
              console.error('Error syncing delete to Postgres:', err);
            } finally {
              pgClient.release();
            }
          }
        } catch (err) {
          console.error('Error processing delete metadata:', err);
        }
      } else if (event.action === "pull") {
        const image = event.target.repository;
        const tag = event.target.tag;
        const mediaType = event.target.mediaType;

        if (!image || !tag || !isManifestPullMediaType(mediaType)) {
          console.log(`hook: pull event skipped repo=${image} tag=${tag} mediaType=${mediaType} (missing tag, repo, or non-manifest-class mediaType — blob pulls and digest-only pulls do not fire last_pulled_at updates)`);
          continue;
        }

        try {
          const parsed = inferredProvenance(image);
          if (parsed) {
            const { organization, name } = parsed;
            const postgresStartedAt = process.hrtime.bigint();
            const pgClient = await pool.connect();
            try {
              const result = await pgClient.query(UPDATE_LAST_PULLED_AT_SQL, [organization, name, tag]);
              console.log(`hook: pull update org=${organization} name=${name} tag=${tag} rows_updated=${result.rowCount} (0 = no matching row OR last_pulled_at refreshed within the past hour)`);
              recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
            } catch (err) {
              recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
              console.error('Error syncing pull to Postgres:', err);
            } finally {
              pgClient.release();
            }
          } else {
            console.log(`hook: pull event repo=${image} did not parse as a known provenance — skipping`);
          }
        } catch (err) {
          console.error('Error processing pull metadata:', err);
        }
      }
    }

    recordRepositoriesScheduledForReap(repositoriesToReap.size);

    for (const repositoryId of repositoriesToReap) {
      const reapStartedAt = process.hrtime.bigint();
      try {
        await reapObsoleteImages({
          repositoryIds: [repositoryId],
          trigger: "push",
        });
        recordImmediateReap("success", elapsedSecondsSince(reapStartedAt));
        markSuccessfulReap();
      } catch (err) {
        recordImmediateReap("error", elapsedSecondsSince(reapStartedAt));
        console.error(`Error reaping stale images for repository ${repositoryId}:`, err);
      }
    }

    markSuccessfulWebhook();

    return {};
  }
}
