import * as redis from "redis";
import { promisify } from "util";

type RedisClient = ReturnType<typeof redis.createClient>;

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    return undefined;
  }

  return value;
}

function getRedisUrl(): string | undefined {
  const directRedisUrl = getEnv("REDISCLOUD_URL");
  if (directRedisUrl != null) {
    return directRedisUrl;
  }

  const host = getEnv("REDIS_HOST");
  if (host == null) {
    return undefined;
  }

  const port = getEnv("REDIS_PORT") || "6379";
  const password = getEnv("REDIS_PASSWORD");

  if (password == null) {
    return `redis://${host}:${port}`;
  }

  return `redis://:${encodeURIComponent(password)}@${host}:${port}`;
}

function createOptionalRedisClient(): RedisClient | null {
  const redisUrl = getRedisUrl();
  if (redisUrl == null) {
    return null;
  }

  return redis.createClient(redisUrl);
}

const client = createOptionalRedisClient();
const saddAsync = client == null ? null : promisify(client.sadd).bind(client);
const hsetAsync = client == null ? null : promisify(client.hset).bind(client);
const sremAsync = client == null ? null : promisify(client.srem).bind(client);
const delAsync = client == null ? null : promisify(client.del).bind(client);

export async function cachePushedImage(imageWithTag: string, pushedAt: Date): Promise<void> {
  if (client == null || saddAsync == null || hsetAsync == null) {
    return;
  }

  const timestamp = pushedAt.getTime();
  await saddAsync("current.images", imageWithTag);
  await hsetAsync(imageWithTag, "created", timestamp, "lastPushed", timestamp);
}

export async function removeCachedImage(imageWithTag: string): Promise<void> {
  if (client == null || sremAsync == null || delAsync == null) {
    return;
  }

  await sremAsync("current.images", imageWithTag);
  await delAsync(imageWithTag);
}
