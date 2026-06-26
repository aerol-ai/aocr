import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { inferredProvenance, parseTagRetention } from "../src/util/tagRetention";

describe("parseTagRetention", () => {
  const ref = new Date("2026-01-01T00:00:00.000Z");

  it("defaults to keep-latest for plain tags", () => {
    const parsed = parseTagRetention("v1.2.3", ref);
    assert.equal(parsed.retentionMode, "keep-latest");
    assert.equal(parsed.retentionValueSeconds, null);
    assert.equal(parsed.expiresAt, null);
  });

  it("parses --ttl-7d suffixes", () => {
    const parsed = parseTagRetention("release--ttl-7d", ref);
    assert.equal(parsed.retentionMode, "ttl");
    assert.equal(parsed.retentionValueSeconds, 7 * 24 * 60 * 60);
    assert.equal(parsed.canonicalRetentionSuffix, "7d");
    assert.equal(parsed.expiresAt?.toISOString(), "2026-01-08T00:00:00.000Z");
  });

  it("parses --idle-90d suffixes without setting expiresAt", () => {
    const parsed = parseTagRetention("cache--idle-90d", ref);
    assert.equal(parsed.retentionMode, "idle");
    assert.equal(parsed.retentionValueSeconds, 90 * 24 * 60 * 60);
    assert.equal(parsed.expiresAt, null);
  });

  it("falls back to keep-latest for unknown suffix tokens", () => {
    const parsed = parseTagRetention("v1--ttl-999y", ref);
    assert.equal(parsed.retentionMode, "keep-latest");
    assert.equal(parsed.rawRetentionSuffix, null);
  });

  it("canonicalizes month aliases", () => {
    const parsed = parseTagRetention("v1--ttl-1month", ref);
    assert.equal(parsed.canonicalRetentionSuffix, "30d");
  });
});

describe("inferredProvenance beyond existing coverage", () => {
  it("returns null for single-segment paths", () => {
    assert.equal(inferredProvenance("onlyone"), null);
  });

  it("classifies pushed repos outside cluster/mirror", () => {
    const info = inferredProvenance("acme/widgets");
    assert.ok(info);
    assert.equal(info!.provenance, "pushed");
    assert.equal(info!.organization, "acme");
    assert.equal(info!.name, "widgets");
  });

  it("accepts label-style cluster ids", () => {
    const info = inferredProvenance("cluster/cluster-abc/snapshots");
    assert.ok(info);
    assert.equal(info!.provenance, "cluster-snapshot");
    assert.equal(info!.clusterId, "cluster-abc");
  });
});
