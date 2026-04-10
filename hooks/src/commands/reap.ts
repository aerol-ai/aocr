import * as util from "util";
import { CronJob } from "cron";
import { logger } from "../logger";
import { getConfiguredRepositoryIds, reapObsoleteImages } from "../util/imageRetention";

const reaperSchedule = process.env["REAPER_SCHEDULE"] || "* * * * *";
const runOnce = ["1", "true", "yes"].indexOf((process.env["REAPER_RUN_ONCE"] || "").toLowerCase()) >= 0;

exports.name = "reap";
exports.describe = "remove older images and keep the latest image per repository";
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

  if (runOnce) {
    await reapObsoleteImages({
      repositoryIds: getConfiguredRepositoryIds(),
      trigger: "run-once",
    });
    return;
  }

  let jobRunning: boolean = false;

  CronJob.from({
    cronTime: reaperSchedule,
    onTick: async () => {
      if (jobRunning) {
        console.log("-----> previous reap job is still running, skipping");
        return;
      }

      console.log("-----> beginning to reap stale images");
      jobRunning = true;

      try {
        await reapObsoleteImages({
          repositoryIds: getConfiguredRepositoryIds(),
          trigger: "cron",
        });
      } catch (err) {
        console.log("failed to reap stale images:", err);
      } finally {
        jobRunning = false;
      }
    },
    start: true,
  });
}
