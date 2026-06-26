import { strict as assert } from "node:assert";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

process.env["INTERNAL_API_TOKEN"] = "test-internal-token";

function fakeRes() {
  let code = 200;
  const r = {
    status(n: number) {
      code = n;
      return r;
    },
  } as any;
  return { r, get code() { return code; } };
}

describe("InternalAPI.blobPresence", () => {
  let closeRegistry: () => Promise<void>;
  let InternalAPICls: typeof import("../src/controllers/InternalAPI").InternalAPI;
  const controller = () => new InternalAPICls();

  before(async () => {
    const blobs = new Map<string, { size: string }>();
    const server = http.createServer((req, res) => {
      if (req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const match = req.url?.match(/^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/i);
      if (!match) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const blob = blobs.get(`${match[1]}:${match[2]}`);
      if (!blob) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-length", blob.size);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    process.env["REGISTRY_URL"] = `http://127.0.0.1:${addr.port}`;
    InternalAPICls = (await import("../src/controllers/InternalAPI")).InternalAPI;
    closeRegistry = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

    blobs.set(
      "acme/app:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      { size: "1234" },
    );
  });

  after(async () => {
    await closeRegistry();
  });

  it("returns 401 without the internal token", async () => {
    const res = fakeRes();
    const out = await controller().blobPresence(res.r, "Token wrong", "acme/app", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(res.code, 401);
    assert.equal(out.error, "unauthorized");
  });

  it("returns 400 for invalid digest format", async () => {
    const res = fakeRes();
    const out = await controller().blobPresence(res.r, "Token test-internal-token", "acme/app", "not-a-digest");
    assert.equal(res.code, 400);
    assert.equal(out.error, "invalid digest");
  });

  it("returns 400 for invalid repository segments", async () => {
    const res = fakeRes();
    const out = await controller().blobPresence(
      res.r,
      "Token test-internal-token",
      "ACME/INVALID",
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert.equal(res.code, 400);
    assert.equal(out.error, "invalid repository");
  });

  it("returns present=true when registry HEAD succeeds", async () => {
    const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = fakeRes();
    const out = await controller().blobPresence(res.r, "Token test-internal-token", "acme/app", digest);
    assert.equal(res.code, 200);
    assert.equal(out.present, true);
    assert.equal(out.sizeBytes, 1234);
  });

  it("returns present=false when registry HEAD is 404", async () => {
    const digest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const res = fakeRes();
    const out = await controller().blobPresence(res.r, "Token test-internal-token", "acme/app", digest);
    assert.equal(res.code, 200);
    assert.equal(out.present, false);
  });

  it("returns 502 for unexpected registry status codes", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    try {
      const digest = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      const res = fakeRes();
      const out = await controller().blobPresence(res.r, "Token test-internal-token", "acme/app", digest);
      assert.equal(res.code, 502);
      assert.equal(out.error, "registry_status_500");
    } finally {
      global.fetch = originalFetch;
    }
  });
});
