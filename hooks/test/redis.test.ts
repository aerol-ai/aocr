import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

import { getRedisUrl } from "../src/util/redis";

describe("getRedisUrl", () => {
  const envBackup = { ...process.env };

  after(() => {
    process.env = { ...envBackup };
  });

  it("returns REDISCLOUD_URL when set", () => {
    process.env["REDISCLOUD_URL"] = "redis://cloud:6379";
    delete process.env["REDIS_HOST"];
    assert.equal(getRedisUrl(), "redis://cloud:6379");
  });

  it("returns undefined when no redis host is configured", () => {
    delete process.env["REDISCLOUD_URL"];
    delete process.env["REDIS_HOST"];
    assert.equal(getRedisUrl(), undefined);
  });

  it("builds a redis URL from host, port, and password", () => {
    delete process.env["REDISCLOUD_URL"];
    process.env["REDIS_HOST"] = "redis.local";
    process.env["REDIS_PORT"] = "6380";
    process.env["REDIS_PASSWORD"] = "p@ss";
    assert.equal(getRedisUrl(), "redis://:p%40ss@redis.local:6380");
  });

  it("builds an unauthenticated redis URL when password is absent", () => {
    delete process.env["REDISCLOUD_URL"];
    process.env["REDIS_HOST"] = "redis.local";
    delete process.env["REDIS_PASSWORD"];
    process.env["REDIS_PORT"] = "6379";
    assert.equal(getRedisUrl(), "redis://redis.local:6379");
  });
});
