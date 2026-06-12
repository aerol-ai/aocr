import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://test:test@127.0.0.1:5432/test";

import { parseMirrorUpstreamRetentionMap, parseProtectedNamespaces } from "../src/util/imageRetention";

describe("parseMirrorUpstreamRetentionMap", () => {
  it("returns empty for missing / blank input", () => {
    assert.deepEqual(parseMirrorUpstreamRetentionMap(""), {});
    assert.deepEqual(parseMirrorUpstreamRetentionMap("   "), {});
  });

  it("returns empty for invalid JSON", () => {
    assert.deepEqual(parseMirrorUpstreamRetentionMap("not json"), {});
    assert.deepEqual(parseMirrorUpstreamRetentionMap("[1,2,3]"), {});
    assert.deepEqual(parseMirrorUpstreamRetentionMap("null"), {});
    assert.deepEqual(parseMirrorUpstreamRetentionMap("123"), {});
  });

  it("parses simple upstream -> seconds mapping", () => {
    const parsed = parseMirrorUpstreamRetentionMap(JSON.stringify({
      "docker": 7 * 24 * 60 * 60,
      "ghcr": 30 * 24 * 60 * 60,
    }));
    assert.equal(parsed["docker"], 604800);
    assert.equal(parsed["ghcr"], 2592000);
  });

  it("drops non-numeric, non-positive, and infinite values", () => {
    const parsed = parseMirrorUpstreamRetentionMap(JSON.stringify({
      "docker": "not a number",
      "ghcr": 0,
      "gcr": -1,
      "quay": 100,
    }));
    assert.deepEqual(Object.keys(parsed).sort(), ["quay"]);
    assert.equal(parsed["quay"], 100);
  });

  it("floors fractional second values", () => {
    const parsed = parseMirrorUpstreamRetentionMap(JSON.stringify({
      "ghcr": 100.9,
    }));
    assert.equal(parsed["ghcr"], 100);
  });
});

describe("parseProtectedNamespaces", () => {
  it("defaults to wasm/std when nothing is configured", () => {
    assert.deepEqual(parseProtectedNamespaces(""), ["wasm/std"]);
  });

  it("splits comma- and newline-separated prefixes and trims trailing slashes", () => {
    assert.deepEqual(
      parseProtectedNamespaces("wasm/std/,\n acme/protected , wasm/std"),
      ["wasm/std", "acme/protected"],
    );
  });

  it("de-dupes while preserving order", () => {
    assert.deepEqual(
      parseProtectedNamespaces("a/b,a/b,c/d"),
      ["a/b", "c/d"],
    );
  });
});
