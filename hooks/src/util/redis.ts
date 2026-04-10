import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

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

  return createClient({ url: redisUrl });
}

const client = createOptionalRedisClient();
if (client != null) {
  client.on("error", (err) => {
    console.warn("redis client error:", err);
  });

  client.connect().catch((err) => {
    console.warn("failed to initialize redis client:", err);
  });
}

async function getClient(): Promise<RedisClient | null> {
  if (client == null || !client.isReady) {
    return null;
  }

  return client;
}

export async function cachePushedImage(imageWithTag: string, pushedAt: Date): Promise<void> {
  const redisClient = await getClient();
  if (redisClient == null) {
    return;
  }

  const timestamp = String(pushedAt.getTime());
  await redisClient.sAdd("current.images", imageWithTag);
  await redisClient.hSet(imageWithTag, {
    created: timestamp,
    lastPushed: timestamp,
  });
}

export async function removeCachedImage(imageWithTag: string): Promise<void> {
  const redisClient = await getClient();
  if (redisClient == null) {
    return;
  }

  await redisClient.sRem("current.images", imageWithTag);
  await redisClient.del(imageWithTag);
}
