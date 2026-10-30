import { test } from "node:test";
import assert from "node:assert/strict";
import { GoalRunner } from "../src/goal-runner.mjs";

const answers = (overrides = {}) => ({
  done: { noul: 0 }, blocked: { noul: 0 }, error: { noul: 0 }, login: { noul: 0 },
  irreversible: { noul: 0 }, tool: { choice: "click" },
  target: { choice: "1", probabilities: { "1": 1 } }, ...overrides,
});

function fixture() {
  const state = { text: "Start", mutations: 0, stale: false };
  const driver = {
    stats: { calls: 0, jev_ms: 0, tokens: 0 },
    events: [],
    execution: { remainingCalls: 10, remainingActions: 2 },
    async settle() {},
    async snapshot() {
      return { url: "fake://screen", title: "Fake", text: state.text, fingerprint: state.text,
        elements: [{ i: 1, label: state.text, actions: ["click"] }] };
    },
    actionSpace(page) { return [...new Set([...page.elements.flatMap(element => element.actions), "wait", "none"])]; },
    async fresh(page, action) {
      if (state.stale) { state.stale = false; return { fresh: false, reason: "page_changed" }; }
      return { fresh: true, current: page, element: page.elements.find(element => element.i === action.target) };
    },
    async act(action) { state.mutations++; state.text = "Finish"; },
    redact(state) { return state; },
    async ask(state, questions) {
      return { answers: state.page.text === "Finish" ? answers({ done: { noul: 1 } }) : answers(), ms: 1, tokens: 1 };
    },
  };
  const strategy = {
    maxRounds: context => context.options.maxActions + 5,
    async decide(context) {
      const { answers: a } = await context.call({ page: context.page, task: { goal: context.goal } }, {
        done: { type: "noul", instructions: "done" }, blocked: { type: "noul", instructions: "blocked" },
        error: { type: "noul", instructions: "error" }, login: { type: "noul", instructions: "login" },
        irreversible: { type: "noul", instructions: "irreversible" }, tool: { type: "choice", instructions: "tool", criteria: { click: null, none: null } },
        target: { type: "choice", instructions: "target", criteria: { "1": null } },
      });
      return { answers: a, action: { tool: a.tool.choice, target: a.tool.choice === "click" ? 1 : null },
        doneScore: a.done.noul, irreversibleScore: a.irreversible.noul,
        round: { round: context.round, tool: a.tool.choice } };
    },
    terminal(decision, context) {
      const a = decision.answers;
      if (decision.doneScore >= context.options.doneAt) return { status: "done", done_score: decision.doneScore };
      if (a.blocked.noul >= 0.7) return { status: "blocked" };
      if (a.error.noul >= 0.7) return { status: "error" };
      if (a.login.noul >= 0.7) return { status: "needs_login" };
      if (decision.action.tool === "none") return { status: "stuck" };
    },
    guarded: action => action.tool === "click",
    signature: (action, context) => `${context.page.fingerprint}:${action.tool}:${action.target}`,
    history: action => ({ action: action.tool, element: action.target == null ? undefined : `#${action.target}` }),
    stopOnActionError: true,
    actionErrorPhase: "mobile_action",
  };
  return { driver, strategy, state };
}

test("GoalRunner coordinates observation, decision, one action and verification without platform objects", async () => {
  const { driver, strategy, state } = fixture();
  const result = await new GoalRunner(driver, strategy).run("Finish");
  assert.equal(result.status, "done");
  assert.equal(result.jev_calls, 2);
  assert.equal(state.mutations, 1);
  assert.equal(driver.execution.remainingActions, 1);
  assert.equal(result.actions.length, 1);
});

test("GoalRunner stale decisions neither mutate nor consume the action budget", async () => {
  const { driver, strategy, state } = fixture();
  state.stale = true;
  let decisions = 0;
  driver.ask = async () => ({ answers: decisions++ === 0 ? answers() : answers({ done: { noul: 1 } }), ms: 0, tokens: 0 });
  const result = await new GoalRunner(driver, strategy).run("Finish", { maxActions: 1 });
  assert.equal(result.status, "done");
  assert.equal(result.rounds[0].stale, "page_changed");
  assert.equal(state.mutations, 0);
  assert.equal(driver.execution.remainingActions, 2);
});

test("GoalRunner authorization is required before a guarded mutation", async () => {
  const { driver, strategy, state } = fixture();
  driver.ask = async state => ({ answers: state.page.text === "Finish" ? answers({ done: { noul: 1 } }) : answers({ irreversible: { noul: 1 } }), ms: 0, tokens: 0 });
  const blocked = await new GoalRunner(driver, strategy).run("Publish");
  assert.equal(blocked.status, "needs_confirmation");
  assert.deepEqual(blocked.pending, { goal: "Publish" });
  assert.equal(state.mutations, 0);
  const allowed = await new GoalRunner(driver, strategy).run("Publish", { allowIrreversible: true });
  assert.equal(allowed.status, "done");
  assert.equal(state.mutations, 1);
});

test("GoalRunner propagates unknown action outcomes and never retries the mutation", async () => {
  const { driver, strategy, state } = fixture();
  driver.act = async () => { state.mutations++; throw Object.assign(new Error("response lost"), { outcome: "unknown", code: "lost_response" }); };
  const result = await new GoalRunner(driver, strategy).run("Finish");
  assert.equal(result.status, "error");
  assert.equal(result.outcome, "unknown");
  assert.equal(result.error.phase, "mobile_action");
  assert.equal(state.mutations, 1);
  assert.equal(driver.execution.remainingActions, 1);
});

test("GoalRunner enforces cancellation and decision budgets before acting", async () => {
  const { driver, strategy, state } = fixture();
  driver.execution.remainingCalls = 0;
  await assert.rejects(new GoalRunner(driver, strategy).run("Finish"), /Decision call budget/);
  assert.equal(state.mutations, 0);
  driver.execution = { signal: AbortSignal.abort(new Error("cancelled")), remainingCalls: 5, remainingActions: 5 };
  await assert.rejects(new GoalRunner(driver, strategy).run("Finish"), /cancelled/);
  assert.equal(state.mutations, 0);
});

test("cancellation during inference cannot be converted into a terminal success", async () => {
  const { driver, strategy, state } = fixture();
  const controller = new AbortController();
  driver.execution.signal = controller.signal;
  driver.ask = async () => {
    controller.abort(new Error("cancelled during decision"));
    return { answers: answers({ done: { noul: 1 } }), ms: 0, tokens: 0 };
  };
  await assert.rejects(new GoalRunner(driver, strategy).run("Finish"), /cancelled during decision/);
  assert.equal(state.mutations, 0);
});
