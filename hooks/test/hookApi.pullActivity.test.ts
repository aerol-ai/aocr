import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://test:test@127.0.0.1:5432/test";

import { UPDATE_LAST_PULLED_AT_SQL } from "../src/controllers/HookAPI";

describe("UPDATE_LAST_PULLED_AT_SQL", () => {
  it("updates last_pulled_at", () => {
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /UPDATE\s+images/i);
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /SET\s+last_pulled_at\s*=\s*CURRENT_TIMESTAMP/i);
  });

  it("matches by organization, name, and tag", () => {
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /r\.organization\s*=\s*\$1/);
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /r\.name\s*=\s*\$2/);
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /i\.tag\s*=\s*\$3/);
  });

  it("does not filter by retention_mode — mirror and keep-latest pulls must also bump last_pulled_at", () => {
    // Regression: previously this query filtered by retention_mode = 'idle', which meant
    // mirror images (stored as keep-latest) never had last_pulled_at updated, so the reaper's
    // mirror-idle expiry — COALESCE(last_pulled_at, last_pushed_at, created_at) in
    // imageRetention.ts — fell back to last_pushed_at and aged out actively-used cache entries.
    assert.doesNotMatch(UPDATE_LAST_PULLED_AT_SQL, /retention_mode/i);
  });

  it("debounces writes with a one-hour guard so popular tags do not write-storm", () => {
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /last_pulled_at\s+IS\s+NULL/i);
    assert.match(UPDATE_LAST_PULLED_AT_SQL, /INTERVAL\s+'1 hour'/i);
  });
});
