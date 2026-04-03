import * as util from "util";
import { CronJob } from "cron";
import { logger } from "../logger";
import * as redis from "redis";
import { promisify } from "util";
import * as rp from "request-promise";
import { Pool } from "pg";

const registryUrl = process.env["REGISTRY_URL"] || "https://ttl.sh";
const client = redis.createClient({url: process.env["REDISCLOUD_URL"]});
const smembersAsync = promisify(client.smembers).bind(client);
const sremAsync = promisify(client.srem).bind(client);
const hgetAsync = promisify(client.hget).bind(client);
const delAsync = promisify(client.del).bind(client);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

exports.name = "reap";
exports.describe = "find and purge expirable images";
exports.builder = {

};

exports.handler = async (argv) => {
  main(argv).catch((err) => {
    console.log(`Failed with error ${util.inspect(err)}`);
    process.exit(1);
  });
};

async function main(argv): Promise<any> {
  process.on("SIGTERM", function onSigterm() {
    logger.info(`Got SIGTERM, cleaning up`);
    process.exit();
  });

  let jobRunning: boolean = false;

  const job = new CronJob({
    cronTime: "* * * * *",
    onTick: async () => {
      if (jobRunning) {
        console.log("-----> previous reap job is still running, skipping");
        return;
      }

      console.log("-----> beginning to reap expired images");
      jobRunning = true;

      try {
        await reapExpiredImages();
      } catch (err) {
        console.log("failed to reap expired images:", err);
      } finally {
        jobRunning = false;
      }
    },
    start: true,
  });

  job.start();
}

async function reapExpiredImages() {
  const pgClient = await pool.connect();
  try {
    const expiredImagesRes = await pgClient.query(`
      SELECT i.id, i.tag, r.organization, r.name 
      FROM images i
      JOIN repositories r ON i.repository_id = r.id
      WHERE i.expires_at <= NOW()
    `);

    console.log(`   there are ${expiredImagesRes.rows.length} expired images to purge`);
    
    for (const row of expiredImagesRes.rows) {
      const image = `${row.organization}/${row.name}:${row.tag}`;
      const repoPath = `${row.organization}/${row.name}`;
      
      try {
        const headers = {
          Accept: "application/vnd.docker.distribution.manifest.v2+json",
        };

        // Get the manifest from the tag
        const getOptions = {
          method: "HEAD",
          uri: `${registryUrl}/v2/${repoPath}/manifests/${row.tag}`,
          headers,
          resolveWithFullResponse: true,
          simple: false,
        };
        const getResponse = await rp(getOptions);

        if (getResponse.statusCode === 404) {
          await pgClient.query('DELETE FROM images WHERE id = $1', [row.id]);
          continue;
        }

        const digest = getResponse.headers.etag.replace(/"/g, "");
        const deleteURI = `${registryUrl}/v2/${repoPath}/manifests/${digest}`;

        // Remove from the registry
        const options = {
          method: "DELETE",
          uri: deleteURI,
          headers,
          resolveWithFullResponse: true,
          simple: false,
        };

        const deleteResponse = await rp(options);
        if (deleteResponse.statusCode === 202 || deleteResponse.statusCode === 204 || deleteResponse.statusCode === 404) {
          console.log(`expiring ${image}`);
          await pgClient.query('DELETE FROM images WHERE id = $1', [row.id]);
          
          // Also cleanup Redis (legacy)
          await sremAsync("current.images", image);
          await delAsync(image);
        } else {
          console.log(`failed to delete ${image} manifest: status ${deleteResponse.statusCode}`);
        }
      } catch (err) {
        console.log(`failed to evaluate image ${image}:`, err);
      }
    }
  } finally {
    pgClient.release();
  }
}
