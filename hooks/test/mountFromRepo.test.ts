import { strict as assert } from "node:assert";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import {
  collectBlobDigests,
  mountAllBlobs,
  mountBlob,
  writeManifest,
} from "../src/util/mountFromRepo";

// Scriptable fake Distribution v2 writer. Each test resets `state` to
// declare how the next request should be answered.
type MountSpec = {
  // Map of `${srcRepo}|${digest}` → status to return for the mount POST.
  // 201 = mounted, 202 = upload session (declined), 404 = not found.
  mountStatus: Map<string, number>;
  // Set of `${dstRepo}|${digest}` known to already exist (used for the
  // 404 → HEAD disambiguation path).
  dstBlobs: Set<string>;
  // Status to return for manifest PUT.
  putStatus: number;
  putDigestHeader: string | null;
  capturedAuth: string[];
  capturedManifestBody: string | null;
  capturedManifestContentType: string | null;
};

function newState(): MountSpec {
  return {
    mountStatus: new Map(),
    dstBlobs: new Set(),
    putStatus: 201,
    putDigestHeader: "sha256:" + "a".repeat(64),
    capturedAuth: [],
    capturedManifestBody: null,
    capturedManifestContentType: null,
  };
}

function startServer(state: { current: MountSpec }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization) state.current.capturedAuth.push(String(req.headers.authorization));
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    // /v2/<repo...>/blobs/uploads/    (mount POST)
    // /v2/<repo...>/blobs/<digest>    (HEAD)
    // /v2/<repo...>/manifests/<tag>   (PUT)
    if (parts[0] !== "v2") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const blobsIdx = parts.indexOf("blobs");
    const manifestsIdx = parts.indexOf("manifests");
    if (blobsIdx > 0 && parts[blobsIdx + 1] === "uploads" && req.method === "POST") {
      const dstRepo = parts.slice(1, blobsIdx).join("/");
      const digest = url.searchParams.get("mount") || "";
      const srcRepo = url.searchParams.get("from") || "";
      const key = `${srcRepo}|${digest}`;
      const status = state.current.mountStatus.get(key) ?? 404;
      res.statusCode = status;
      if (status === 201) {
        res.setHeader("location", `/v2/${dstRepo}/blobs/${digest}`);
      }
      res.end();
      return;
    }
    if (blobsIdx > 0 && req.method === "HEAD") {
      const dstRepo = parts.slice(1, blobsIdx).join("/");
      const digest = decodeURIComponent(parts.slice(blobsIdx + 1).join("/"));
      const has = state.current.dstBlobs.has(`${dstRepo}|${digest}`);
      res.statusCode = has ? 200 : 404;
      res.end();
      return;
    }
    if (manifestsIdx > 0 && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        state.current.capturedManifestBody = body;
        state.current.capturedManifestContentType = req.headers["content-type"] as string;
        res.statusCode = state.current.putStatus;
        if (state.current.putDigestHeader) {
          res.setHeader("docker-content-digest", state.current.putDigestHeader);
        }
        res.end();
      });
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

const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const D3 = "sha256:" + "3".repeat(64);

describe("collectBlobDigests", () => {
  it("returns config + layers for image manifests, deduped", () => {
    const out = collectBlobDigests({
      schemaVersion: 2,
      config: { digest: D1 },
      layers: [{ digest: D2 }, { digest: D3 }, { digest: D2 }],
    });
    assert.deepEqual(out, [D1, D2, D3]);
  });

  it("returns sub-manifest digests for index manifests", () => {
    const out = collectBlobDigests({
      schemaVersion: 2,
      manifests: [{ digest: D1 }, { digest: D2 }],
    });
    assert.deepEqual(out, [D1, D2]);
  });

  it("ignores descriptors without digest", () => {
    const out = collectBlobDigests({
      schemaVersion: 2,
      layers: [{ digest: D1 }, { digest: "" } as any, {} as any],
    });
    assert.deepEqual(out, [D1]);
  });
});

describe("mountBlob", () => {
  const state = { current: newState() };
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const s = await startServer(state);
    baseUrl = s.baseUrl;
    close = s.close;
  });
  after(async () => { await close(); });

  it("returns 'mounted' on 201", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 201);
    const r = await mountBlob("src/repo", "dst/repo", D1, { registryUrl: baseUrl });
    assert.deepEqual(r, { digest: D1, status: "mounted" });
  });

  it("returns 'failed' on 202 (mount declined)", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 202);
    const r = await mountBlob("src/repo", "dst/repo", D1, { registryUrl: baseUrl });
    assert.equal(r.status, "failed");
    assert.match(r.detail || "", /declined/);
  });

  it("on 404, HEADs destination and returns 'present' when blob already there", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 404);
    state.current.dstBlobs.add(`dst/repo|${D1}`);
    const r = await mountBlob("src/repo", "dst/repo", D1, { registryUrl: baseUrl });
    assert.deepEqual(r, { digest: D1, status: "present" });
  });

  it("on 404 with no dest blob, returns 'failed' (source missing)", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 404);
    const r = await mountBlob("src/repo", "dst/repo", D1, { registryUrl: baseUrl });
    assert.equal(r.status, "failed");
    assert.match(r.detail || "", /not found/);
  });

  it("forwards authorization header", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 201);
    await mountBlob("src/repo", "dst/repo", D1, { registryUrl: baseUrl, authorization: "Token abc" });
    assert.ok(state.current.capturedAuth.includes("Token abc"));
  });
});

describe("mountAllBlobs", () => {
  const state = { current: newState() };
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const s = await startServer(state);
    baseUrl = s.baseUrl;
    close = s.close;
  });
  after(async () => { await close(); });

  it("returns allMounted=true when every digest mounts", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 201);
    state.current.mountStatus.set(`src/repo|${D2}`, 201);
    const r = await mountAllBlobs(
      { schemaVersion: 2, config: { digest: D1 }, layers: [{ digest: D2 }] },
      "src/repo",
      "dst/repo",
      { registryUrl: baseUrl },
    );
    assert.equal(r.allMounted, true);
    assert.equal(r.outcomes.length, 2);
  });

  it("stops at first hard failure and returns partial outcomes", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 201);
    state.current.mountStatus.set(`src/repo|${D2}`, 404);
    // D3 should never be attempted.
    const r = await mountAllBlobs(
      { schemaVersion: 2, config: { digest: D1 }, layers: [{ digest: D2 }, { digest: D3 }] },
      "src/repo",
      "dst/repo",
      { registryUrl: baseUrl },
    );
    assert.equal(r.allMounted, false);
    assert.equal(r.outcomes.length, 2);
    assert.equal(r.outcomes[1].status, "failed");
  });

  it("treats 'present' as a successful step", async () => {
    state.current = newState();
    state.current.mountStatus.set(`src/repo|${D1}`, 404);
    state.current.dstBlobs.add(`dst/repo|${D1}`);
    state.current.mountStatus.set(`src/repo|${D2}`, 201);
    const r = await mountAllBlobs(
      { schemaVersion: 2, config: { digest: D1 }, layers: [{ digest: D2 }] },
      "src/repo",
      "dst/repo",
      { registryUrl: baseUrl },
    );
    assert.equal(r.allMounted, true);
    assert.equal(r.outcomes[0].status, "present");
  });
});

describe("writeManifest", () => {
  const state = { current: newState() };
  let baseUrl: string;
  let close: () => Promise<void>;

  before(async () => {
    const s = await startServer(state);
    baseUrl = s.baseUrl;
    close = s.close;
  });
  after(async () => { await close(); });

  it("PUTs the manifest with the supplied content-type and returns digest", async () => {
    state.current = newState();
    const body = JSON.stringify({ schemaVersion: 2 });
    const r = await writeManifest("dst/repo", "v1.0", body, "application/vnd.oci.image.manifest.v1+json", {
      registryUrl: baseUrl,
    });
    assert.equal(r.status, 201);
    assert.equal(r.digest, state.current.putDigestHeader);
    assert.equal(state.current.capturedManifestBody, body);
    assert.equal(state.current.capturedManifestContentType, "application/vnd.oci.image.manifest.v1+json");
  });

  it("returns the registry's non-201 status verbatim", async () => {
    state.current = newState();
    state.current.putStatus = 400;
    state.current.putDigestHeader = null;
    const r = await writeManifest("dst/repo", "v1.0", "{}", "application/json", { registryUrl: baseUrl });
    assert.equal(r.status, 400);
    assert.equal(r.digest, null);
  });
});
