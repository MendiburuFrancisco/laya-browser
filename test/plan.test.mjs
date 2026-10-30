import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlan } from "../src/plan.mjs";

const fake = statuses => {
  const invoked = [];
  const b = { stats: { calls: 0 }, currentUrl: "https://example.test/home",
    open: async url => { invoked.push(["open", url]); },
    do: async (goal, options) => { invoked.push([goal, options]); b.stats.calls++; return { status: statuses.shift(), pending: { action: "click" } }; },
    settle: async () => {}, snapshot: async () => ({ url: "https://example.test/home", text: "Ready", elements: [{ i: 7, label: "Email" }] }),
    readValue: async () => "test@example.org" };
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

test("navigation failure preserves multiline driver details and nested network cause", async () => {
  const { b, invoked } = fake([]);
  b.open = async () => { throw new Error("page.goto failed\nCall log:\n  navigating to destination", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) }); };
  const r = await runPlan(b, [{ goal: "first" }], { url: "https://example.test" });
  assert.equal(r.phase, "navigation");
  assert.equal(r.completed, 0);
  assert.equal(invoked.length, 0);
  assert.match(r.error.message, /Call log:[\s\S]*ECONNREFUSED/);
  assert.match(r.error.hint, /network/);
});

test("navigation failure preserves Appium phase and unknown outcome without running dependents", async () => {
  const { b, invoked } = fake([]);
  b.capabilities = () => ({ native: true });
  b.open = async () => { throw Object.assign(new Error("Appium POST timed out"), {
    code: "appium_timeout", outcome: "unknown",
    diagnostic: { phase: "session_create", transport_phase: "http_body", outcome: "unknown", attempt_id: "attempt-1" },
  }); };
  const r = await runPlan(b, [{ goal: "must not login" }, { goal: "must not select a plan" }], { app: { package: "com.demo" } });
  assert.equal(r.phase, "navigation");
  assert.equal(r.outcome, "unknown");
  assert.equal(r.error.phase, "session_create");
  assert.equal(r.error.transport_phase, "http_body");
  assert.equal(r.error.attempt_id, "attempt-1");
  assert.equal(invoked.length, 0);
});

test("stopped plans explain exhausted actions and preserve the last action failures", async () => {
  const { b } = fake([]);
  b.do = async () => ({ status: "max_actions", actions: [{ action: "click", element: "Submit", error: "target is disabled" }] });
  const r = await runPlan(b, [{ goal: "submit" }, { goal: "continue" }]);
  assert.match(r.info, /max_actions/);
  assert.equal(r.action_errors[0].error, "target is disabled");
  assert.equal(r.remaining, 2);
  assert.match(r.resume, /remaining tail/);
});

test("verification identifies failed conditions independently of property order without field secrets", async () => {
  const { b } = fake(["done"]);
  const r = await runPlan(b, [{ goal: "verify", values: { password: "super-secret" }, verify: {
    field: { label: "Email", value_key: "password" }, text_includes: "Ready", url_includes: "/missing",
  } }]);
  assert.equal(r.phase, "verification");
  assert.deepEqual(r.verification_failures, ["url_includes", "field"]);
  assert.ok(!JSON.stringify(r).includes("super-secret"));
});

test("plan preserves execution stop status instead of converting budget exhaustion to error", async () => {
  const { b } = fake([]);
  b.do = async () => { throw Object.assign(new Error("Decision call budget exhausted"), { status: "limit_exceeded" }); };
  const r = await runPlan(b, [{ goal: "first" }]);
  assert.equal(r.status, "limit_exceeded");
});
