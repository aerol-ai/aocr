import { strict as assert } from "node:assert";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

process.env["INTERNAL_API_TOKEN"] = "test-internal-token";

// A scriptable fake Distribution v2 registry. Drives both the source-side
// GETs (manifest fetch) and destination-side POSTs/PUTs (mount + write).
type FakeRegistryState = {
  // Map of `${repo}@${digest}` → {body, contentType} for source manifest GET.
  sourceManifests: Map<string, { body: string; contentType: string }>;
  // Map of `${repo}:${tag}` → digest for destination manifest HEAD (idempotency).
  dstTagDigests: Map<string, string>;
  // Mountable digests as `${srcRepo}|${digest}` → status.
  mountStatus: Map<string, number>;
  // Destination blobs already present (for 404 → HEAD path).
  dstBlobs: Set<string>;
  // Manifest PUT status (per-test override).
  putStatus: number;
  putDigest: string | null;
  // Capture for assertions.
  capturedPutBody: string | null;
  capturedPutPath: string | null;
};

function newState(): FakeRegistryState {
  return {
    sourceManifests: new Map(),
    dstTagDigests: new Map(),
    mountStatus: new Map(),
    dstBlobs: new Set(),
    putStatus: 201,
    putDigest: null,
    capturedPutBody: null,
    capturedPutPath: null,
  };
}

function startFakeRegistry(state: { current: FakeRegistryState }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v2") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const blobsIdx = parts.indexOf("blobs");
    const manifestsIdx = parts.indexOf("manifests");

    if (manifestsIdx > 0 && req.method === "GET") {
      const repo = parts.slice(1, manifestsIdx).join("/");
      const ref = decodeURIComponent(parts.slice(manifestsIdx + 1).join("/"));
      const m = state.current.sourceManifests.get(`${repo}@${ref}`);
      if (!m) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", m.contentType);
      res.setHeader("docker-content-digest", ref);
      res.end(m.body);
      return;
    }

    if (manifestsIdx > 0 && req.method === "HEAD") {
      const repo = parts.slice(1, manifestsIdx).join("/");
      const ref = decodeURIComponent(parts.slice(manifestsIdx + 1).join("/"));
      const digest = state.current.dstTagDigests.get(`${repo}:${ref}`);
      if (!digest) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("docker-content-digest", digest);
      res.end();
      return;
    }

    if (manifestsIdx > 0 && req.method === "PUT") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.current.capturedPutBody = body;
        state.current.capturedPutPath = url.pathname;
        res.statusCode = state.current.putStatus;
        if (state.current.putDigest) {
          res.setHeader("docker-content-digest", state.current.putDigest);
        }
        res.end();
      });
      return;
    }

    if (blobsIdx > 0 && parts[blobsIdx + 1] === "uploads" && req.method === "POST") {
      const digest = url.searchParams.get("mount") || "";
      const srcRepo = url.searchParams.get("from") || "";
      const status = state.current.mountStatus.get(`${srcRepo}|${digest}`) ?? 404;
      res.statusCode = status;
      res.end();
      return;
    }

    if (blobsIdx > 0 && req.method === "HEAD") {
      const dstRepo = parts.slice(1, blobsIdx).join("/");
      const digest = parts.slice(blobsIdx + 1).join("/");
      res.statusCode = state.current.dstBlobs.has(`${dstRepo}|${digest}`) ? 200 : 404;
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_CFG = "sha256:" + "b".repeat(64);
const DIGEST_LAYER = "sha256:" + "c".repeat(64);

function imageManifest(): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.docker.distribution.manifest.v2+json",
    config: { digest: DIGEST_CFG, mediaType: "application/vnd.docker.container.image.v1+json", size: 1234 },
    layers: [{ digest: DIGEST_LAYER, mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", size: 5678 }],
  });
}

describe("ImportAPI", () => {
  const state = { current: newState() };
  let baseUrl: string;
  let close: () => Promise<void>;
  let ImportAPICls: any;

  before(async () => {
    const s = await startFakeRegistry(state);
    baseUrl = s.baseUrl;
    close = s.close;
    process.env["REGISTRY_URL"] = baseUrl;
    // Import after env vars are set — module reads REGISTRY_URL at load.
    ImportAPICls = (await import("../src/controllers/ImportAPI")).ImportAPI;
  });
  after(async () => { await close(); });
  beforeEach(() => { state.current = newState(); });

  function controller() { return new ImportAPICls(); }

  function fakeRes() {
    let code = 0;
    const r: any = { status: (n: number) => { code = n; return r; } };
    return { r, get code() { return code; } };
  }

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      upstream_host: "ghcr.io",
      upstream_repo: "aerol-ai/sandbox",
      upstream_tag: "v1.2.3",
      upstream_digest: DIGEST_A,
      cluster_id: "cluster-abc",
      ...overrides,
    };
  }

  it("rejects with 401 when authorization is missing", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, undefined, validBody());
    assert.equal(res.code, 401);
    assert.equal(out.error, "unauthorized");
  });

  it("rejects with 401 when authorization is wrong", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token wrong", validBody());
    assert.equal(res.code, 401);
    assert.equal(out.error, "unauthorized");
  });

  it("rejects with 400 on invalid upstream_digest", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody({ upstream_digest: "not-a-digest" }));
    assert.equal(res.code, 400);
    assert.match(out.error, /upstream_digest/);
  });

  it("rejects with 400 on invalid cluster_id (with /)", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody({ cluster_id: "bad/id" }));
    assert.equal(res.code, 400);
    assert.match(out.error, /cluster_id/);
  });

  it("rejects with 400 on invalid target_tag_suffix", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody({ target_tag_suffix: "no-dashes-prefix" }));
    assert.equal(res.code, 400);
    assert.match(out.error, /target_tag_suffix/);
  });

  it("returns 200 already_present when destination tag resolves to the same digest", async () => {
    state.current.dstTagDigests.set(`cluster/cluster-abc/_imported/ghcr.io/aerol-ai/sandbox:v1.2.3--idle-90d`, DIGEST_A);
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 200);
    assert.equal(out.imported, false);
    assert.equal(out.already_present, true);
    assert.equal(out.target_tag, "v1.2.3--idle-90d");
    assert.equal(out.target_repository, "cluster/cluster-abc/_imported/ghcr.io/aerol-ai/sandbox");
    assert.equal(out.digest, DIGEST_A);
  });

  it("performs end-to-end mount + manifest write on the happy path", async () => {
    state.current.sourceManifests.set(`mirror/ghcr.io/aerol-ai/sandbox@${DIGEST_A}`, {
      body: imageManifest(),
      contentType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_CFG}`, 201);
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_LAYER}`, 201);
    state.current.putStatus = 201;
    state.current.putDigest = DIGEST_A;

    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 201, JSON.stringify(out));
    assert.equal(out.imported, true);
    assert.equal(out.already_present, false);
    assert.equal(out.target_repository, "cluster/cluster-abc/_imported/ghcr.io/aerol-ai/sandbox");
    assert.equal(out.target_tag, "v1.2.3--idle-90d");
    assert.equal(out.digest, DIGEST_A);
    assert.equal(state.current.capturedPutPath, "/v2/cluster/cluster-abc/_imported/ghcr.io/aerol-ai/sandbox/manifests/v1.2.3--idle-90d");
    assert.equal(state.current.capturedPutBody, imageManifest());
  });

  it("returns 404 when source manifest is missing", async () => {
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 404);
    assert.equal(out.error, "source_manifest_not_found");
  });

  it("returns 501 for multi-arch index manifests", async () => {
    state.current.sourceManifests.set(`mirror/ghcr.io/aerol-ai/sandbox@${DIGEST_A}`, {
      body: JSON.stringify({ schemaVersion: 2, manifests: [{ digest: DIGEST_CFG }] }),
      contentType: "application/vnd.oci.image.index.v1+json",
    });
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 501);
    assert.equal(out.error, "multi_arch_not_implemented");
  });

  it("returns 502 with outcomes when a blob mount fails", async () => {
    state.current.sourceManifests.set(`mirror/ghcr.io/aerol-ai/sandbox@${DIGEST_A}`, {
      body: imageManifest(),
      contentType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_CFG}`, 201);
    // Layer mount fails (source blob absent — common case when mirror hasn't
    // yet been asked to pull the layer through).
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_LAYER}`, 404);
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 502);
    assert.equal(out.error, "mount_failed");
    assert.ok(Array.isArray(out.outcomes));
    assert.equal(out.outcomes.length, 2);
  });

  it("returns 502 when manifest PUT is rejected", async () => {
    state.current.sourceManifests.set(`mirror/ghcr.io/aerol-ai/sandbox@${DIGEST_A}`, {
      body: imageManifest(),
      contentType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_CFG}`, 201);
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_LAYER}`, 201);
    state.current.putStatus = 400;
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody());
    assert.equal(res.code, 502);
    assert.match(out.error, /manifest_put_failed_400/);
  });

  it("accepts a custom valid target_tag_suffix", async () => {
    state.current.sourceManifests.set(`mirror/ghcr.io/aerol-ai/sandbox@${DIGEST_A}`, {
      body: imageManifest(),
      contentType: "application/vnd.docker.distribution.manifest.v2+json",
    });
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_CFG}`, 201);
    state.current.mountStatus.set(`mirror/ghcr.io/aerol-ai/sandbox|${DIGEST_LAYER}`, 201);
    state.current.putDigest = DIGEST_A;
    const res = fakeRes();
    const out = await controller().importImage(res.r, "Token test-internal-token", validBody({ target_tag_suffix: "--idle-30d" }));
    assert.equal(res.code, 201);
    assert.equal(out.target_tag, "v1.2.3--idle-30d");
  });
});
