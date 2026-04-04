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

interface ErrorResponse {
  error: any;
}

const pool = createPool();

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
      response.status(401);
      return {};
    }

    const repositoriesToReap = new Set<string>();

    for (const event of body.events) {
      if (event.action === "push") {
        const image = event.target.repository;
        const tag = event.target.tag;

        if (!image || !tag) {
          continue;
        }

        const imageWithTag = `${image}:${tag}`;
        const pushedAt = new Date();

        // Redis (legacy/cache)
        await cachePushedImage(imageWithTag, pushedAt);

        // Postgres metadata store
        try {
          const [org, repo] = image.split('/');
          if (org && repo) {
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
              repositoriesToReap.add(repoId);
            } catch (err) {
              await pgClient.query('ROLLBACK');
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

    for (const repositoryId of repositoriesToReap) {
      try {
        await reapObsoleteImages({
          repositoryIds: [repositoryId],
          trigger: "push",
        });
      } catch (err) {
        console.error(`Error reaping stale images for repository ${repositoryId}:`, err);
      }
    }

    return {};
  }
}
