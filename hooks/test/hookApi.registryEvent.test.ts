process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://test:test@127.0.0.1:5432/test";
process.env["HOOK_TOKEN"] = "hook-secret";

import { strict as assert } from "node:assert";
import { before, beforeEach, describe, it } from "node:test";

type QueryCall = { text: string; values: unknown[] };
type ProcessRegistryEvents = typeof import("../src/controllers/hookEvents").processRegistryEvents;

function fakeRes() {
  let code = 0;
  const r: any = {
    status(n: number) {
      code = n;
      return r;
    },
  };
  return { r, get code() { return code; } };
}

describe("processRegistryEvents", () => {
  const queries: QueryCall[] = [];
  let reapCalls = 0;
  let processRegistryEvents: ProcessRegistryEvents;

  const fakePool = {
    connect: async () => ({
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        if (/INSERT INTO repositories/i.test(text)) {
          return { rows: [{ id: "repo-uuid-1" }] };
        }
        if (/INSERT INTO images/i.test(text)) {
          return { rows: [] };
        }
        if (/UPDATE images/i.test(text)) {
          return { rowCount: 1 };
        }
        if (/DELETE FROM images/i.test(text)) {
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {},
    }),
  };

  before(async () => {
    ({ processRegistryEvents } = await import("../src/controllers/hookEvents"));
  });

  beforeEach(() => {
    queries.length = 0;
    reapCalls = 0;
  });

  it("upserts pushed image metadata into Postgres", async () => {
    await processRegistryEvents({
      events: [{
        action: "push",
        target: {
          repository: "acme/widgets",
          tag: "v1--idle-90d",
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }],
    }, {
      pgPool: fakePool as any,
      cachePush: async () => {},
      reap: async () => {
        reapCalls++;
        return 0;
      },
    });

    assert.ok(queries.some((q) => /INSERT INTO images/i.test(q.text)));
    assert.ok(queries.some((q) => q.values.includes("idle")));
    assert.equal(reapCalls, 1);
  });

  it("updates last_pulled_at for manifest-class pull events", async () => {
    await processRegistryEvents({
      events: [{
        action: "pull",
        target: {
          repository: "acme/widgets",
          tag: "latest",
          mediaType: "application/vnd.oci.image.index.v1+json",
        },
      }],
    }, {
      pgPool: fakePool as any,
      cachePush: async () => {},
      reap: async () => 0,
    });

    assert.ok(queries.some((q) => /last_pulled_at/i.test(q.text)));
  });

  it("deletes rows for manifest delete events", async () => {
    await processRegistryEvents({
      events: [{
        action: "delete",
        target: {
          repository: "acme/widgets",
          digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      }],
    }, {
      pgPool: fakePool as any,
      cachePush: async () => {},
      reap: async () => 0,
    });

    assert.ok(queries.some((q) => /DELETE FROM images/i.test(q.text)));
  });

  it("skips blob pull events", async () => {
    await processRegistryEvents({
      events: [{
        action: "pull",
        target: {
          repository: "acme/widgets",
          tag: "latest",
          mediaType: "application/octet-stream",
        },
      }],
    }, {
      pgPool: fakePool as any,
      cachePush: async () => {},
      reap: async () => 0,
    });

    assert.equal(queries.some((q) => /last_pulled_at/i.test(q.text)), false);
  });

  it("continues when redis cache writes fail", async () => {
    await processRegistryEvents({
      events: [{
        action: "push",
        target: {
          repository: "acme/widgets",
          tag: "v1",
          digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      }],
    }, {
      pgPool: fakePool as any,
      cachePush: async () => {
        throw new Error("redis down");
      },
      reap: async () => 0,
    });

    assert.ok(queries.some((q) => /INSERT INTO images/i.test(q.text)));
  });

  it("handles empty event batches", async () => {
    await processRegistryEvents({ events: [] }, {
      pgPool: fakePool as any,
      cachePush: async () => {},
      reap: async () => 0,
    });
    assert.equal(queries.length, 0);
  });

  it("rolls back postgres when image upsert fails", async () => {
    const rollbackQueries: string[] = [];
    const failingPool = {
      connect: async () => ({
        query: async (text: string) => {
          rollbackQueries.push(text);
          if (text === "BEGIN") {
            return { rows: [] };
          }
          if (/INSERT INTO repositories/i.test(text)) {
            return { rows: [{ id: "repo-uuid-1" }] };
          }
          if (/INSERT INTO images/i.test(text)) {
            throw new Error("db write failed");
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    await processRegistryEvents({
      events: [{
        action: "push",
        target: {
          repository: "acme/widgets",
          tag: "v1",
        },
      }],
    }, {
      pgPool: failingPool as any,
      cachePush: async () => {},
      reap: async () => 0,
    });

    assert.ok(rollbackQueries.includes("ROLLBACK"));
  });
});

describe("HookAPI authorization", () => {
  it("rejects unauthorized webhook calls", async () => {
    const { HookAPI } = await import("../src/controllers/HookAPI");
    const res = fakeRes();
    await new HookAPI().hook(res.r, {} as any, "Token wrong", { events: [] });
    assert.equal(res.code, 401);
  });
});
