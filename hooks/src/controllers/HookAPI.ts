import * as Express from "express";
import {
  Controller,
  Post,
  Res,
  HeaderParams,
  BodyParams,
  Req} from "ts-express-decorators";
import * as parseDuration from "parse-duration";
import * as redis from "redis";
import { promisify } from "util";
import { Pool } from "pg";

interface ErrorResponse {
  error: any;
}

const client = redis.createClient({url: process.env["REDISCLOUD_URL"]});
const saddAsync = promisify(client.sadd).bind(client);
const hsetAsync = promisify(client.hset).bind(client);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const durationRegex = /^(?=\d+[ywdhms])(( ?\d+y)?(?!\d))?(( ?\d+w)?(?!\d))?(( ?\d+d)?(?!\d))?(( ?\d+h)?(?!\d))?(( ?\d+m)?(?!\d))?(( ?\d+s)?(?!\d))?( ?\d+ms)?$/;
const defaultDuration = 24 * 60 * 60 * 1000; // 24h
const maxDuration = 24 * 60 * 60 * 1000; // 24h

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

    for (const event of body.events) {
      if (event.action === "push") {
        const image = event.target.repository;
        const tag = event.target.tag;

        if (!image || !tag) {
          continue;
        }

        const imageWithTag = `${image}:${tag}`;

        console.log(`parsing tag ${tag}`);
        let expiresIn = durationfromTag(tag);
        if (expiresIn <= 0) {
          expiresIn = defaultDuration;
        }
        if (expiresIn > maxDuration) {
          expiresIn = maxDuration;
        }

        const now = new Date().getTime();
        const then = now + expiresIn;

        // Redis (legacy/cache)
        await saddAsync("current.images", imageWithTag);
        await hsetAsync(imageWithTag, "created", now, "expires", then);

        // Postgres (New Metadata Store)
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
                'INSERT INTO images (repository_id, tag, expires_at) VALUES ($1, $2, $3) ON CONFLICT (repository_id, tag) DO UPDATE SET expires_at = $3',
                [repoId, tag, new Date(then)]
              );

              await pgClient.query('COMMIT');
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

    return {};
  }
}

function durationfromTag(tag: string): number {
  if (!durationRegex.test(tag)) {
    return -1;
  }
  return parseDuration(tag);
}
