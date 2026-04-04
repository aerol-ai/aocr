import { Pool, PoolConfig } from "pg";

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    return undefined;
  }

  return value;
}

function getDatabaseConnectionString(): string {
  const directConnectionString = getEnv("DATABASE_URL");
  if (directConnectionString != null) {
    return directConnectionString;
  }

  const host = getEnv("POSTGRES_HOST");
  const database = getEnv("POSTGRES_DB");
  const user = getEnv("POSTGRES_USER");
  const password = getEnv("POSTGRES_PASSWORD");
  const port = getEnv("POSTGRES_PORT") || "5432";

  if (host == null || database == null || user == null || password == null) {
    throw new Error("DATABASE_URL or POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD must be configured");
  }

  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

export function createPool(): Pool {
  const config: PoolConfig = {
    connectionString: getDatabaseConnectionString(),
  };

  return new Pool(config);
}
