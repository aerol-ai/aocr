import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

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
  recordWebhookAuthorization,
} from "../src/metrics";

describe("hooks metrics helpers", () => {
  it("records webhook and registry metrics without throwing", () => {
    recordWebhookAuthorization("accepted");
    recordRegistryEvent("push");
    recordRegistryEventBatch(2);
    recordPostgresSync("success", 0.01);
    recordRedisCache("success", 0.01);
    recordImmediateReap("success", 0.01);
    recordRepositoriesScheduledForReap(1);
    markSuccessfulWebhook();
    markSuccessfulReap();
    assert.ok(elapsedSecondsSince(process.hrtime.bigint()) >= 0);
  });
});
