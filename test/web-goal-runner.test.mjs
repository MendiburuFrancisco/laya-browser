import { test } from "node:test";
import assert from "node:assert/strict";
import { JevBrowser } from "../src/session.mjs";
import { invokeBrowser } from "../src/browser-api.mjs";
import { cacheKey } from "../src/locator-cache.mjs";
import { GoalRunner } from "../src/goal-runner.mjs";
import { runPlan, verificationFailures } from "../src/plan.mjs";

function fixture() {
  const state = { done: false, mutations: 0, text: "Continue", irreversible: 0 };
  const b = Object.create(JevBrowser.prototype);
  const entries = new Map();
  const url = "https://runner.test/";
  b.stats = { calls: 0, jev_ms: 0, tokens: 0 };
  b.events = [];
  b.execution = { remainingCalls: 10, remainingActions: 2 };
  b._page = { url: () => url };
  b.cache = { get: key => entries.get(key), put: (key, value) => entries.set(key, value), evict: key => entries.delete(key) };
  b.snapshot = async () => ({ url, title: "Test", text: state.text,
    elements: [{ i: 1, tag: "button", text: state.text, xpath: "/html/body/button" }] });
  b.settle = async () => {};
  b.webmcpTools = async () => [];
  b.decide = async () => ({ done: { noul: state.done ? 1 : 0 }, done_change: { noul: state.done ? 1 : 0 },
    blocked: { noul: 0 }, error: { noul: 0 }, login: { noul: 0 }, irreversible: { noul: state.irreversible },
    tool: { choice: "click", probabilities: { click: 1 } }, target: { probabilities: { "1": 1 } }, stages: 1 });
  b.ask = async () => ({ answers: { irreversible: { noul: state.irreversible } }, ms: 0, tokens: 0 });
  b.execute = async () => { state.mutations++; state.done = true; return 1; };
  entries.set(cacheKey("Continue", url, 0), { tool: "click", xpath: "/html/body/button", frame: null, brief: 'button "Continue"' });
  return { b, state, entries };
}

test("web cache replay passes through the common runner and exact host authorization", async () => {
  const { b, state } = fixture();
  state.irreversible = 1;
  const blocked = await invokeBrowser(b, "do", { goal: "Continue" }, { authorizedGoals: ["Other goal"] });
  assert.equal(blocked.status, "needs_confirmation");
  assert.equal(state.mutations, 0);
  assert.equal(b.execution.remainingActions, 2);
  const allowed = await invokeBrowser(b, "do", { goal: "Continue" }, { authorizedGoals: ["Continue"] });
  assert.equal(allowed.status, "done");
  assert.equal(state.mutations, 1);
  assert.deepEqual(allowed.cache, { hits: 1, saved: 0 });
  assert.ok(b.goalRunner instanceof GoalRunner);
});

test("web cache cannot treat an unanswered irreversible question as permission", async () => {
  const { b, state } = fixture();
  b.ask = async () => ({ answers: {}, ms: 0, tokens: 0 });
  assert.equal((await b.do("Continue")).status, "needs_confirmation");
  assert.equal(state.mutations, 0);
});

test("web cache freshness prevents mutation without spending the action budget", async () => {
  const { b, state } = fixture();
  b.ask = async () => {
    state.text = "Changed";
    state.done = true;
    return { answers: { irreversible: { noul: 0 } }, ms: 0, tokens: 0 };
  };
  const result = await b.do("Continue", { maxActions: 1 });
  assert.equal(result.status, "done");
  assert.equal(result.rounds[0].cached, true);
  assert.equal(result.rounds[0].stale, "target_missing");
  assert.equal(state.mutations, 0);
  assert.equal(b.execution.remainingActions, 2);
});

test("web cache uses the same sticky action budget as normal decisions", async () => {
  const { b, state } = fixture();
  b.execution.remainingActions = 0;
  await assert.rejects(b.do("Continue"), /Browser action budget exhausted/);
  assert.equal(state.mutations, 0);
  await assert.rejects(b.do("Continue"), /Browser action budget exhausted/);
});

test("short web secrets are structurally redacted in inference and returned diagnostics", async () => {
  const { b, state } = fixture();
  state.text = "PIN 1";
  let sent;
  b.ask = async input => { sent = input; return { answers: {}, ms: 0, tokens: 0 }; };
  await b.runGoal("Observe", { values: { pin: "1" }, maxActions: 0 });
  await b.call({ page: await b.snapshot(), bounds: { width: 100 }, target: 1 }, {});
  assert.equal(sent.page.text, "PIN [redacted]");
  assert.equal(sent.page.elements[0].i, 1);
  assert.equal(sent.bounds.width, 100);
  assert.equal(sent.target, 1);
  const result = await b.do("Observe", { values: { pin: "1" }, maxActions: 0 });
  assert.doesNotMatch(JSON.stringify(result), /PIN 1/);
});

test("an ordinary web action failure stops the goal and its dependent plan steps", async () => {
  const { b, state } = fixture();
  b.cache = null;
  b.execute = async () => { state.mutations++; state.done = true; throw new Error("response lost after submit"); };
  const result = await runPlan(b, [{ goal: "Submit" }, { goal: "Must not execute" }]);
  assert.equal(result.status, "error");
  assert.equal(result.completed, 0);
  assert.equal(state.mutations, 1);
  assert.equal(result.action_errors.length, 1);
});

test("a timed out WebMCP mutation is unknown and never submitted twice", async () => {
  const { b, state } = fixture();
  b.cache = null;
  b.webmcpTools = async () => [{ name: "send", inputSchema: {} }];
  b.resolve = () => ({ tool: "webmcp", webmcp: "send", args: {}, readOnly: false, p_tool: 1, p_target: 1, candidates: [], target: null });
  b.execute = JevBrowser.prototype.execute;
  b._page.evaluate = () => { state.mutations++; return new Promise(() => {}); };
  b.runWebmcp = (name, args) => JevBrowser.prototype.runWebmcp.call(b, name, args, 5);
  const result = await runPlan(b, [{ goal: "Send", max_actions: 4 }, { goal: "Must not execute" }]);
  assert.equal(result.status, "error");
  assert.equal(result.outcome, "unknown");
  assert.equal(result.completed, 0);
  assert.equal(state.mutations, 1);
});

test("web logs redact echoed credentials and action error messages before callbacks", async () => {
  const { b, state } = fixture();
  b.cache = null;
  state.text = "PIN 1234";
  b.execute = async () => { throw new Error("failed typing secret 1234"); };
  const logs = [];
  const result = await b.do("Continue", { values: { pin: "1234" }, log: message => logs.push(message) });
  assert.equal(result.status, "error");
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify({ logs, result }), /1234/);
});

test("successive waits use their loading policy rather than the mutation anti-loop guard", async () => {
  const { b, state } = fixture();
  b.cache = null;
  b.execution.remainingActions = 6;
  b.resolve = () => ({ tool: "wait", target: null, p_tool: 1, p_target: 0, candidates: [] });
  b.execute = async () => { state.mutations++; state.done = state.mutations === 4; };
  const result = await b.do("Wait for loading", { maxActions: 6 });
  assert.equal(result.status, "done");
  assert.equal(result.actions.length, 4);
  assert.ok(result.actions.every(action => action.action === "wait"));
});

test("a stale Box is rejected before consuming an action budget", async () => {
  const { b, state } = fixture();
  b.cache = null;
  b.resolve = () => ({ tool: "click", boxId: "box-1", el: { tag: "button", text: "Continue" }, target: null, p_tool: 1, p_target: 1, candidates: [] });
  b.freshBox = async () => { state.done = true; throw new Error("Screenshot changed since box selection"); };
  const result = await b.do("Click the box", { maxActions: 1 });
  assert.equal(result.status, "done");
  assert.equal(result.rounds[0].stale, "target_changed");
  assert.equal(state.mutations, 0);
  assert.equal(b.execution.remainingActions, 2);
});

test("overlay recovery cannot exceed the goal's local action budget", async () => {
  const { b, state } = fixture();
  b.cache = null;
  const originalSnapshot = b.snapshot;
  b.snapshot = async () => {
    const page = await originalSnapshot();
    page.elements.push({ i: 2, tag: "button", text: "Close" });
    return page;
  };
  b.execute = async () => { state.mutations++; throw new Error("subtree intercepts pointer events"); };
  const result = await b.do("Continue", { maxActions: 1 });
  assert.equal(result.status, "max_actions");
  assert.equal(state.mutations, 1);
  assert.equal(b.execution.remainingActions, 1);
});

test("field verification uses its own observation instead of previously shown indices", async () => {
  const { b } = fixture();
  b.shown = { url: "https://runner.test/", elements: [{ i: 1, label: "Old" }, { i: 2, label: "New" }] };
  b.snapshot = async () => ({ url: "https://runner.test/", text: "", elements: [
    { i: 1, label: "New", value: "WRONG" }, { i: 2, label: "Old", value: "expected" },
  ] });
  const failures = await verificationFailures(b, { values: { expected: "expected" }, verify: { field: { label: "New", value_key: "expected" } } });
  assert.deepEqual(failures, ["field"]);
});

test("web runner observations omit executable locators even on cache misses", async () => {
  const { b } = fixture();
  b.cache = null;
  const decide = b.decide;
  b.decide = async page => {
    assert.doesNotMatch(JSON.stringify(page), /xpath|\/html\/body\/button/);
    return decide(page);
  };
  assert.equal((await b.do("Continue")).status, "done");
});

test("a fatal cache replay evicts its entry without retrying the current goal", async () => {
  const { b, state, entries } = fixture();
  const execute = b.execute;
  b.execute = async () => { state.mutations++; throw new Error("target is disabled"); };
  const failed = await b.do("Continue");
  assert.equal(failed.status, "error");
  assert.equal(state.mutations, 1);
  assert.equal(entries.size, 0);
  b.execute = execute;
  const recovered = await b.do("Continue");
  assert.equal(recovered.status, "done");
  assert.equal(recovered.rounds[0].cached, undefined);
  assert.equal(state.mutations, 2);
});

test("select resolves label or value before dispatch and never retries a lost response", async () => {
  const { b, state } = fixture();
  b.cache = null;
  b.resolve = () => ({ tool: "select", target: 1, el: { tag: "select", text: "Continue" }, value: "A", p_tool: 1, p_target: 1, candidates: [] });
  b.locate = () => ({ evaluate: async () => true,
    selectOption: async choice => { assert.deepEqual(choice, { label: "A" }); state.mutations++; throw new Error("response lost after change event"); } });
  b.execute = JevBrowser.prototype.execute;
  const result = await runPlan(b, [{ goal: "Select" }, { goal: "Must not execute" }]);
  assert.equal(result.status, "error");
  assert.equal(result.outcome, "unknown");
  assert.equal(result.completed, 0);
  assert.equal(state.mutations, 1);
  assert.equal(b.execution.remainingActions, 1);
});

test("type does not silently repeat input when the field rejects its value", async () => {
  const { b } = fixture();
  let fills = 0, entries = 0;
  b.locate = () => ({ fill: async () => { fills++; }, pressSequentially: async () => { entries++; }, inputValue: async () => "wrong" });
  await assert.rejects(JevBrowser.prototype.execute.call(b, { tool: "type", target: 1, value: "expected" }), error => error.outcome === "unknown");
  assert.equal(fills, 1);
  assert.equal(entries, 1);
});

test("select cancellation during option resolution prevents the mutation", async () => {
  const { b } = fixture();
  const controller = new AbortController();
  b.execution.signal = controller.signal;
  let selections = 0;
  b.locate = () => ({ evaluate: async () => { controller.abort(new Error("cancelled resolving options")); return true; },
    selectOption: async () => { selections++; } });
  b.execute = JevBrowser.prototype.execute;
  await assert.rejects(b.act({ tool: "select", target: 1, value: "A" }), /cancelled resolving options/);
  assert.equal(selections, 0);
});
