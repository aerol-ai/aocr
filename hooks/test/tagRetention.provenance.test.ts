import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { inferredProvenance } from "../src/util/tagRetention";

const CLUSTER_UUID = "aabbccdd-eeff-0011-2233-445566778899";

describe("inferredProvenance", () => {
  it("returns null for missing / empty / single-segment paths", () => {
    assert.equal(inferredProvenance(undefined), null);
    assert.equal(inferredProvenance(null), null);
    assert.equal(inferredProvenance(""), null);
    assert.equal(inferredProvenance("aocr"), null);
    assert.equal(inferredProvenance("aocr/"), null);
    assert.equal(inferredProvenance("/aocr"), null);
  });

  it("flags ordinary org/repo paths as pushed", () => {
    const parsed = inferredProvenance("aocr/my-image");
    assert.deepEqual(parsed, {
      provenance: "pushed",
      organization: "aocr",
      name: "my-image",
      clusterId: null,
      upstreamRef: null,
    });
  });

  it("handles multi-segment org/repo paths under a pushed namespace", () => {
    const parsed = inferredProvenance("teamfoo/sub/path/image");
    assert.deepEqual(parsed, {
      provenance: "pushed",
      organization: "teamfoo",
      name: "sub/path/image",
      clusterId: null,
      upstreamRef: null,
    });
  });

  it("flags cluster/<uuid>/<name> as cluster-snapshot and extracts cluster_id", () => {
    const parsed = inferredProvenance(`cluster/${CLUSTER_UUID}/sandbox-snap-xyz`);
    assert.deepEqual(parsed, {
      provenance: "cluster-snapshot",
      organization: "cluster",
      name: `${CLUSTER_UUID}/sandbox-snap-xyz`,
      clusterId: CLUSTER_UUID,
      upstreamRef: null,
    });
  });

  it("flags cluster/<label>/<name> as cluster-snapshot and extracts the label cluster_id", () => {
    const parsed = inferredProvenance("cluster/prod-aerolvm-us-east-1/templates/py311");
    assert.equal(parsed?.provenance, "cluster-snapshot");
    assert.equal(parsed?.clusterId, "prod-aerolvm-us-east-1");
    assert.equal(parsed?.name, "prod-aerolvm-us-east-1/templates/py311");
  });

  it("flags cluster/<label>/wasm-checkpoints/<sandbox-id> as cluster-snapshot", () => {
    const parsed = inferredProvenance("cluster/prod-aerolvm-us-east-1/wasm-checkpoints/sb-1");
    assert.equal(parsed?.provenance, "cluster-snapshot");
    assert.equal(parsed?.clusterId, "prod-aerolvm-us-east-1");
    assert.equal(parsed?.name, "prod-aerolvm-us-east-1/wasm-checkpoints/sb-1");
  });

  it("leaves cluster_id null when the second segment is not a valid cluster label", () => {
    // A dot is outside the cluster-id charset (^[A-Za-z0-9_-]{1,64}$); still
    // flagged cluster-snapshot, just without extractable cluster metadata.
    const parsed = inferredProvenance("cluster/has.dot/sandbox-snap-xyz");
    assert.equal(parsed?.provenance, "cluster-snapshot");
    assert.equal(parsed?.clusterId, null);
    assert.equal(parsed?.name, "has.dot/sandbox-snap-xyz");
  });

  it("preserves deep snapshot paths under cluster/", () => {
    const parsed = inferredProvenance(
      `cluster/${CLUSTER_UUID}/_imported/ghcr.io/private-org/foo`,
    );
    assert.equal(parsed?.organization, "cluster");
    assert.equal(parsed?.name, `${CLUSTER_UUID}/_imported/ghcr.io/private-org/foo`);
    assert.equal(parsed?.clusterId, CLUSTER_UUID);
  });

  it("flags mirror/* as mirror and captures upstreamRef as the path tail", () => {
    const parsed = inferredProvenance("mirror/aocr/ghcr/aerol-ai/foo");
    assert.deepEqual(parsed, {
      provenance: "mirror",
      organization: "mirror",
      name: "aocr/ghcr/aerol-ai/foo",
      clusterId: null,
      upstreamRef: "aocr/ghcr/aerol-ai/foo",
    });
  });

  it("does not mistake a namespace starting with 'mirror' for the mirror namespace", () => {
    const parsed = inferredProvenance("mirrorshady/foo");
    assert.equal(parsed?.provenance, "pushed");
  });

  it("does not mistake a namespace starting with 'cluster' for the cluster namespace", () => {
    const parsed = inferredProvenance(`cluster${CLUSTER_UUID}/foo`);
    assert.equal(parsed?.provenance, "pushed");
  });
});
