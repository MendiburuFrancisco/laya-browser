import { test } from "node:test";
import assert from "node:assert/strict";
import { errorDiagnostic } from "../src/diagnostics.mjs";
import { JevBrowser } from "../src/session.mjs";

test("diagnostics retain nested causes, stop cycles and explicitly bound long errors", () => {
  const e = new Error("fetch failed", { cause: Object.assign(new Error("localhost:8791"), { code: "ECONNREFUSED" }) });
  e.cause.cause = e;
  const d = errorDiagnostic(e);
  assert.match(d.message, /Caused by: ECONNREFUSED: localhost:8791/);
  assert.match(d.hint, /JEV_API_URL/);
  const long = errorDiagnostic(new Error("x".repeat(10000)));
  assert.match(long.message, /details truncated/);
  assert.ok(long.message.length < 6100);
});

test("main-frame inspection failures propagate instead of producing an empty successful page", async () => {
  const frame = { childFrames: () => [], evaluate: async () => { throw new Error("Target page, context or browser has been closed"); } };
  const b = Object.create(JevBrowser.prototype);
  b._page = { mainFrame: () => frame, url: () => "https://example.test" };
  for (const method of ["snapshot", "extractBlocks"]) {
    await assert.rejects(b[method](), e => {
      assert.match(e.message, /main page/);
      assert.match(errorDiagnostic(e).message, /browser has been closed/);
      return true;
    });
  }
});
