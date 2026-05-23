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
      } else if (event.action === "pull") {
        const image = event.target.repository;
        const tag = event.target.tag;
        const mediaType = event.target.mediaType;

        if (!image || !tag || !mediaType || !mediaType.includes("manifest")) {
          continue;
        }

        try {
          const parsed = inferredProvenance(image);
          if (parsed) {
            const { organization, name } = parsed;
            const postgresStartedAt = process.hrtime.bigint();
            const pgClient = await pool.connect();
            try {
              await pgClient.query(`
                UPDATE images i
                SET last_pulled_at = CURRENT_TIMESTAMP
                FROM repositories r
                WHERE i.repository_id = r.id
                  AND r.organization = $1
                  AND r.name = $2
                  AND i.tag = $3
                  AND i.retention_mode = 'idle'
                  AND (i.last_pulled_at IS NULL OR i.last_pulled_at < CURRENT_TIMESTAMP - INTERVAL '1 hour')
              `, [organization, name, tag]);
              recordPostgresSync("success", elapsedSecondsSince(postgresStartedAt));
            } catch (err) {
              recordPostgresSync("error", elapsedSecondsSince(postgresStartedAt));
              console.error('Error syncing pull to Postgres:', err);
            } finally {
              pgClient.release();
            }
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
