import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../src/plan.mjs";

const fake = statuses => {
  const invoked = [];
  const b = { stats: { calls: 0 }, page: { url: () => "https://example.test/home" },
    open: async url => { invoked.push(["open", url]); },
    do: async (goal, options) => { invoked.push([goal, options]); b.stats.calls++; return { status: statuses.shift(), pending: { action: "click" } }; },
    settle: async () => {}, snapshot: async () => ({ url: "https://example.test/home", text: "Ready", elements: [{ i: 7, label: "Email" }] }),
    locate: () => ({ inputValue: async () => "test@example.org" }) };
  return { b, invoked };
};
test("plan executes ordered steps and forwards per-step options", async () => {
  const { b, invoked } = fake(["done", "done"]);
  const result = await runPlan(b, [{ goal: "first", values: { email: "test@example.org" }, verify: { field: { label: "Email", value_key: "email" } } },
    { goal: "second", max_actions: 3, allow_irreversible: true }], { url: "https://example.test" });
  assert.equal(result.status, "done"); assert.equal(result.completed, 2); assert.equal(result.decision_calls, 2);
  assert.deepEqual(invoked.map(x => x[0]), ["open", "first", "second"]);
  assert.equal(invoked[2][1].allowIrreversible, true); assert.equal(invoked[1][1].allowIrreversible, false);
});
test("plan stops on uncertainty without executing later steps", async () => {
  const { b, invoked } = fake(["done", "likely_done", "done"]);
  const result = await runPlan(b, [{ goal: "first" }, { goal: "second" }, { goal: "third" }]);
  assert.equal(result.status, "likely_done"); assert.equal(result.failed_step, 2);
  assert.equal(result.completed, 1); assert.equal(result.remaining, 2); assert.equal(invoked.length, 2);
  assert.deepEqual(result.pending, { action: "click" });
});
test("plan detects false done with page postconditions", async () => {
  const { b, invoked } = fake(["done", "done"]);
  const result = await runPlan(b, [{ goal: "navigate", verify: { url_includes: "/booking" } }, { goal: "continue" }]);
  assert.equal(result.status, "verification_failed"); assert.equal(result.completed, 0); assert.equal(invoked.length, 1);
});
test("plan preserves completed progress on inference exception", async () => {
  const { b } = fake(["done"]);
  const original = b.do;
  b.do = async (goal, options) => { if (goal === "second") throw new Error("Local model unavailable"); return original(goal, options); };
  const result = await runPlan(b, [{ goal: "first" }, { goal: "second" }, { goal: "third" }]);
  assert.equal(result.status, "error"); assert.equal(result.failed_step, 2);
  assert.equal(result.completed, 1); assert.match(result.info, /unavailable/);
});

test("plan waits for a new matching download during step verification", async () => {
  const { b } = fake(["done"]);
  b.downloads = { items: [], wait: async ({ afterId }) => {
    assert.equal(afterId, "");
    b.downloads.items.push({ id: "download-1", filename: "errors.csv", status: "completed" });
    return { status: "completed", downloads: [...b.downloads.items] };
  } };
  const result = await runPlan(b, [{ goal: "download report", verify: { download: { filename: "errors.csv", timeout_ms: 1000 } } }]);
  assert.equal(result.status, "done");
  assert.equal(result.completed, 1);
});
