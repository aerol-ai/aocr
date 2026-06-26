import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

process.env["DATABASE_URL"] = process.env["DATABASE_URL"] || "postgres://test:test@127.0.0.1:5432/test";

import {
  buildRepositoryScope,
  getConfiguredRepositoryIds,
  reapObsoleteImages,
} from "../src/util/imageRetention";

describe("buildRepositoryScope", () => {
  it("returns empty scope for all repositories", () => {
    assert.deepEqual(buildRepositoryScope([]), {
      query: "",
      values: [],
      label: "all repositories",
    });
  });

  it("filters by repository ids when provided", () => {
    const scope = buildRepositoryScope(["repo-1", "repo-2"]);
    assert.match(scope.query, /repository_id = ANY/i);
    assert.deepEqual(scope.values, [["repo-1", "repo-2"]]);
  });
});

describe("getConfiguredRepositoryIds", () => {
  it("parses comma-separated REPOSITORY_IDS", () => {
    process.env["REPOSITORY_IDS"] = "a, b ,c";
    assert.deepEqual(getConfiguredRepositoryIds(), ["a", "b", "c"]);
    delete process.env["REPOSITORY_IDS"];
  });
});

describe("reapObsoleteImages", () => {
  const originalFetch = global.fetch;
  const fetchCalls: Array<{ url: string; method?: string }> = [];
  let deleteStatus = 204;

  before(() => {
    process.env["REGISTRY_URL"] = "http://registry.test";
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, method: init?.method });
      if (init?.method === "DELETE") {
        return new Response(null, { status: deleteStatus });
      }
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 404,
          headers: { "docker-content-digest": "sha256:deadbeef" },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it("deletes stale rows when registry delete succeeds", async () => {
    fetchCalls.length = 0;
    deleteStatus = 204;
    const pgQueries: string[] = [];
    const fakePool = {
      connect: async () => ({
        query: async (text: string) => {
          pgQueries.push(text);
          if (/reap_candidates/i.test(text)) {
            return {
              rows: [{
                id: "img-1",
                repository_id: "repo-1",
                tag: "old",
                organization: "acme",
                name: "widgets",
                manifest_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              }],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    const count = await reapObsoleteImages({ trigger: "test" }, fakePool as any);
    assert.equal(count, 1);
    assert.ok(fetchCalls.some((c) => c.method === "DELETE"));
    assert.ok(pgQueries.some((q) => /DELETE FROM images WHERE id/i.test(q)));
  });

  it("drops rows when manifest digest cannot be resolved", async () => {
    fetchCalls.length = 0;
    const pgQueries: string[] = [];
    const fakePool = {
      connect: async () => ({
        query: async (text: string) => {
          pgQueries.push(text);
          if (/reap_candidates/i.test(text)) {
            return {
              rows: [{
                id: "img-2",
                repository_id: "repo-1",
                tag: "gone",
                organization: "acme",
                name: "widgets",
                manifest_digest: null,
              }],
            };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    const count = await reapObsoleteImages({}, fakePool as any);
    assert.equal(count, 1);
    assert.ok(pgQueries.some((q) => /DELETE FROM images WHERE id = \$1/i.test(q)));
  });
});
