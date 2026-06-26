import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { HealthzAPI } from "../src/controllers/HealthzAPI";

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

describe("HealthzAPI.check", () => {
  it("returns HTTP 200 with an empty body object", async () => {
    const res = fakeRes();
    const out = await new HealthzAPI().check(res.r);
    assert.equal(res.code, 200);
    assert.deepEqual(out, {});
  });
});
