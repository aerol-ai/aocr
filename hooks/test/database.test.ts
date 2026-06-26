import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

import { getDatabaseConnectionString } from "../src/util/database";

describe("getDatabaseConnectionString", () => {
  const envBackup = { ...process.env };

  after(() => {
    process.env = { ...envBackup };
  });

  it("uses DATABASE_URL when configured", () => {
    process.env["DATABASE_URL"] = "postgres://u:p@host/db";
    delete process.env["POSTGRES_HOST"];
    assert.equal(getDatabaseConnectionString(), "postgres://u:p@host/db");
  });

  it("builds a connection string from POSTGRES_* variables", () => {
    delete process.env["DATABASE_URL"];
    process.env["POSTGRES_HOST"] = "db.local";
    process.env["POSTGRES_DB"] = "aocr";
    process.env["POSTGRES_USER"] = "user";
    process.env["POSTGRES_PASSWORD"] = "pass";
    process.env["POSTGRES_PORT"] = "5433";
    assert.equal(
      getDatabaseConnectionString(),
      "postgres://user:pass@db.local:5433/aocr",
    );
  });

  it("throws when database configuration is incomplete", () => {
    delete process.env["DATABASE_URL"];
    delete process.env["POSTGRES_HOST"];
    assert.throws(() => getDatabaseConnectionString(), /must be configured/);
  });
});
