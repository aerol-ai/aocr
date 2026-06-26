import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://test:test@127.0.0.1:5432/test";

import { DELETE_MANIFEST_SQL, UPDATE_LAST_PULLED_AT_SQL, isManifestPullMediaType } from "../src/controllers/hookEvents";

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

describe("isManifestPullMediaType", () => {
  it("accepts Docker schema v1 and v2 manifest types", () => {
    assert.equal(isManifestPullMediaType("application/vnd.docker.distribution.manifest.v1+json"), true);
    assert.equal(isManifestPullMediaType("application/vnd.docker.distribution.manifest.v2+json"), true);
  });

  it("accepts Docker schema v2 manifest list", () => {
    assert.equal(isManifestPullMediaType("application/vnd.docker.distribution.manifest.list.v2+json"), true);
  });

  it("accepts OCI image manifest", () => {
    assert.equal(isManifestPullMediaType("application/vnd.oci.image.manifest.v1+json"), true);
  });

  it("accepts OCI image index (multi-arch) — regression for multi-arch pulls not updating last_pulled_at", () => {
    // The OCI spec renamed manifest-list to image.index. The literal "manifest"
    // does not appear in the media type, so the old `mediaType.includes("manifest")`
    // filter dropped every multi-arch pull event. Confirmed in production logs
    // for `docker pull mirror/docker/library/rust:slim-trixie`.
    assert.equal(isManifestPullMediaType("application/vnd.oci.image.index.v1+json"), true);
  });

  it("rejects blob and unrelated media types", () => {
    assert.equal(isManifestPullMediaType("application/octet-stream"), false);
    assert.equal(isManifestPullMediaType("application/json"), false);
    assert.equal(isManifestPullMediaType("text/plain"), false);
  });

  it("rejects empty, null, undefined, and non-string inputs", () => {
    assert.equal(isManifestPullMediaType(""), false);
    assert.equal(isManifestPullMediaType(null), false);
    assert.equal(isManifestPullMediaType(undefined), false);
    assert.equal(isManifestPullMediaType(42), false);
    assert.equal(isManifestPullMediaType({}), false);
  });
});

describe("DELETE_MANIFEST_SQL", () => {
  it("deletes from images joined to repositories", () => {
    assert.match(DELETE_MANIFEST_SQL, /DELETE\s+FROM\s+images/i);
    assert.match(DELETE_MANIFEST_SQL, /USING\s+repositories/i);
  });

  it("matches by organization, name, and manifest_digest — never by tag", () => {
    // The registry emits one delete event per manifest digest (tag-less). A digest
    // can be referenced by multiple tags in the same repo; they all go away when
    // the manifest is gone, so matching on digest reaps every affected row.
    assert.match(DELETE_MANIFEST_SQL, /r\.organization\s*=\s*\$1/);
    assert.match(DELETE_MANIFEST_SQL, /r\.name\s*=\s*\$2/);
    assert.match(DELETE_MANIFEST_SQL, /i\.manifest_digest\s*=\s*\$3/);
    assert.doesNotMatch(DELETE_MANIFEST_SQL, /i\.tag\s*=/);
  });
});
