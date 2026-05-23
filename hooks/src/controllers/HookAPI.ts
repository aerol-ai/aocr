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

        if (!image || !tag) {
          continue;
        }

        const imageWithTag = `${image}:${tag}`;
        const pushedAt = new Date();

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
          const [org, repo] = image.split('/');
          if (org && repo) {
            const postgresStartedAt = process.hrtime.bigint();
            const pgClient = await pool.connect();
            try {
              await pgClient.query('BEGIN');
              
              const repoRes = await pgClient.query(
                'INSERT INTO repositories (organization, name) VALUES ($1, $2) ON CONFLICT (organization, name) DO UPDATE SET name = $2 RETURNING id',
                [org, repo]
              );
              const repoId = repoRes.rows[0].id;

              await pgClient.query(
                "INSERT INTO images (repository_id, tag, last_pushed_at) VALUES ($1, $2, $3) ON CONFLICT (repository_id, tag) DO UPDATE SET last_pushed_at = EXCLUDED.last_pushed_at",
                [repoId, tag, pushedAt]
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
