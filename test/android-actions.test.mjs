import { test } from "node:test";
import assert from "node:assert/strict";
import { AppiumAndroidDriver } from "../src/drivers/appium/driver.mjs";
import { AppiumClient } from "../src/drivers/appium/client.mjs";
import { performAndroidAction } from "../src/drivers/appium/android-actions.mjs";
import { parseAndroidSnapshot } from "../src/drivers/appium/android-snapshot.mjs";
import { doStep, invokeBrowser } from "../src/browser-api.mjs";
import { runPlan } from "../src/plan.mjs";
import { BrowserSessions } from "../src/browser-sessions.mjs";
import { normalizeTarget } from "../src/target-config.mjs";

const source = text => `<hierarchy width="400" height="800"><android.widget.Button class="android.widget.Button" text="${text}" enabled="true" clickable="true" bounds="[0,20][400,90]"/></hierarchy>`;
const field = parseAndroidSnapshot(`<hierarchy><node class="android.widget.EditText" text="" enabled="true" clickable="true" bounds="[0,0][200,80]"/></hierarchy>`).elements[0];
const id = "element-6066-11e4-a52e-4f735466cecf";
const answers = (overrides = {}) => ({ done: { noul: 0 }, blocked: { noul: 0 }, error: { noul: 0 }, login: { noul: 0 }, irreversible: { noul: 0 }, tool: { choice: "click" }, target: { choice: "1", probabilities: { "1": 1 } }, ...overrides });

function fixture() {
  let xml = source("About phone");
  const mutations = [];
  const client = {
    async command(method, path, body) {
      if (method !== "GET") mutations.push({ method, path, body });
      if (path === "source") return xml;
      if (path.endsWith("current_package")) return "com.android.settings";
      if (path.endsWith("current_activity")) return ".Settings";
      if (path === "element/active") return { [id]: "field" };
    },
    async findElement(xpath) { assert.match(xpath, /@bounds/); return "field"; },
    async elementCommand(element, method, path, body) {
      mutations.push({ element, method, path, body });
      if (path === "click") xml = source("Model");
    },
  };
  const driver = new AppiumAndroidDriver({ client });
  driver.settle = async () => {};
  driver.ask = async state => ({ answers: state.page.text === "Model" ? answers({ done: { noul: 1 } }) : answers(), ms: 1, tokens: 1 });
  return { driver, client, mutations, change: text => { xml = source(text); } };
}

test("native do performs one grounded click and verifies the resulting screen", async () => {
  const { driver, mutations } = fixture();
  const result = await doStep(driver, { goal: "Open About phone", max_actions: 1, verify: { text_includes: "Model", app_package: "com.android.settings", activity_includes: "Settings", element: { label: "Model", state: "enabled" } } });
  assert.equal(result.status, "done", result.info);
  assert.equal(mutations.length, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.jev_calls, 2);
});

test("invented actions or incompatible targets never reach Appium", async () => {
  for (const decision of [answers({ tool: { choice: "upload" } }), answers({ target: { choice: "999", probabilities: { "999": 1 } } })]) {
    const { driver, mutations } = fixture();
    driver.ask = async () => ({ answers: decision, ms: 0, tokens: 0 });
    const result = await driver.do("Open About phone");
    assert.ok(["error", "ambiguous"].includes(result.status));
    assert.equal(mutations.length, 0);
  }
});

test("Android scroll ignores a value-key answer intended only for type", async () => {
  const { driver, mutations, change } = fixture();
  const snapshot = driver.snapshot.bind(driver);
  driver.snapshot = async () => {
    const page = await snapshot();
    page.elements[0].actions.push("scroll");
    return page;
  };
  let decisions = 0;
  driver.ask = async () => ({ answers: decisions++ === 0 ? answers({ tool: { choice: "scroll" }, value: { choice: "email" }, direction: { choice: "down" } }) : answers({ done: { noul: 1 } }), ms: 0, tokens: 0 });
  const result = await driver.do("Reveal content", { values: { email: "test@example.org" } });
  assert.equal(result.status, "done");
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, "actions");
});

test("irreversible and unanswered policy require confirmation before mutation", async () => {
  for (const irreversible of [{ noul: 1 }, undefined]) {
    const { driver, mutations } = fixture();
    driver.ask = async () => ({ answers: answers({ irreversible }), ms: 0, tokens: 0 });
    assert.equal((await driver.do("Change a setting")).status, "needs_confirmation");
    assert.equal(mutations.length, 0);
  }
});

test("changed screen invalidates a decision without spending its mutation budget", async () => {
  const { driver, mutations, change } = fixture();
  let decisions = 0;
  driver.ask = async () => {
    if (decisions++ === 0) { change("Model"); return { answers: answers(), ms: 0, tokens: 0 }; }
    return { answers: answers({ done: { noul: 1 } }), ms: 0, tokens: 0 };
  };
  driver.execution = { remainingCalls: 5, remainingActions: 1 };
  const result = await driver.do("Open About phone", { maxActions: 1 });
  assert.equal(result.status, "done");
  assert.equal(result.rounds[0].stale, "page_changed");
  assert.equal(driver.execution.remainingActions, 1);
  assert.equal(mutations.length, 0);
});

test("Code Mode authorization applies only to the exact native goal", async () => {
  const { driver, mutations } = fixture();
  driver.ask = async state => ({ answers: state.page.text === "Model" ? answers({ done: { noul: 1 } }) : answers({ irreversible: { noul: 1 } }), ms: 0, tokens: 0 });
  const blocked = await invokeBrowser(driver, "do", { goal: "Open About phone" }, { authorizedGoals: ["Some other goal"] });
  assert.equal(blocked.status, "needs_confirmation");
  assert.equal(mutations.length, 0);
  const allowed = await invokeBrowser(driver, "do", { goal: "Open About phone" }, { authorizedGoals: ["Open About phone"] });
  assert.equal(allowed.status, "done");
  assert.equal(mutations.length, 1);
});

test("direct actions reject stale indices and do not silently renumber after mutation", async () => {
  const { driver, mutations, change } = fixture();
  await driver.snapshotText();
  change("Other");
  await assert.rejects(driver.actOn({ action: "click", element: 1 }), /stale/);
  assert.equal(mutations.length, 0);
  await driver.snapshotText();
  await driver.actOn({ action: "click", element: 1 });
  await assert.rejects(driver.actOn({ action: "click", element: 1 }), /snapshot/);
});

test("type verifies focus before and after clear, then sends the value exactly once", async () => {
  const calls = [];
  const client = {
    findElement: async () => "field",
    elementCommand: async (_, method, path, body) => calls.push({ path, body }),
    command: async () => { calls.push({ path: "active" }); return { [id]: "field" }; },
  };
  await performAndroidAction(client, field, { tool: "type", value: "About phone" });
  assert.deepEqual(calls.map(call => call.path), ["click", "active", "clear", "active", "value"]);
  assert.equal(calls.at(-1).body.text, "About phone");
  calls.length = 0;
  client.command = async () => ({ [id]: "another" });
  await assert.rejects(performAndroidAction(client, field, { tool: "type", value: "secret" }), /focus/);
  assert.deepEqual(calls.map(call => call.path), ["click"]);
});

test("lost mutation responses and invalid JSON are never retried, with unknown outcome", async () => {
  for (const response of [async () => { throw new Error("echoed-secret"); }, async () => new Response("broken-json")]) {
    let calls = 0;
    const client = new AppiumClient({ fetchImpl: async (...args) => { calls++; return response(...args); } });
    client.sessionId = "own-session";
    await assert.rejects(client.command("POST", "back", {}, { mutation: true }), error => {
      assert.equal(error.outcome, "unknown");
      assert.equal(error.diagnostic.phase, "mobile_action");
      assert.doesNotMatch(error.message, /echoed-secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("failed Android action and false done both stop dependent plan steps", async () => {
  const { driver, client } = fixture();
  client.elementCommand = async () => { throw Object.assign(new Error("response unavailable"), { outcome: "unknown" }); };
  const failed = await runPlan(driver, [{ goal: "Open About phone" }, { goal: "Must not execute" }]);
  assert.equal(failed.status, "error");
  assert.equal(failed.outcome, "unknown");
  assert.equal(failed.completed, 0);
  const other = fixture().driver;
  other.ask = async () => ({ answers: answers({ done: { noul: 1 } }), ms: 0, tokens: 0 });
  const falseDone = await runPlan(other, [{ goal: "Open model", verify: { text_includes: "Model" } }, { goal: "Must not execute" }]);
  assert.equal(falseDone.status, "verification_failed");
  assert.deepEqual(falseDone.verification_failures, ["text_includes"]);
});

test("native locators stay private and hidden descendants never enter observations", () => {
  const page = parseAndroidSnapshot(`<hierarchy width="100" height="100"><node class="android.view.View" displayed="false" bounds="[0,0][100,100]"><node class="android.widget.TextView" text="hidden" bounds="[0,0][90,90]"/></node><node class="android.widget.Button" text="Visible" enabled="true" clickable="true" bounds="[0,0][200,200]"/></hierarchy>`);
  assert.equal(page.elements.length, 1);
  assert.equal(page.elements[0].bounds.width, 100);
  assert.ok(page.elements[0]._native.xpath);
  assert.doesNotMatch(JSON.stringify(page), /hidden|xpath|_native/);
});

test("password values are redacted in decisions, snapshots, history and fingerprints", async () => {
  const { driver, change } = fixture();
  change("Model");
  let observed;
  driver.ask = async state => { observed = state; return { answers: answers({ done: { noul: 1 } }), ms: 0, tokens: 0 }; };
  const result = await driver.do("Observe current screen", { values: { password: "Model" } });
  assert.equal(observed.task.values.password, "[redacted]");
  assert.doesNotMatch(JSON.stringify(observed), /Model/);
  assert.doesNotMatch(JSON.stringify(result), /Model/);
  assert.doesNotMatch(JSON.stringify(await driver.snapshot()), /Model/);
});

test("creation or cleanup with an unknown outcome blocks implicit retries", async () => {
  let requests = 0;
  const client = new AppiumClient({ fetchImpl: async () => { requests++; throw new Error("lost"); } });
  await assert.rejects(client.createSession({}), error => error.outcome === "unknown");
  await assert.rejects(client.createSession({}), /Previous session creation/);
  assert.equal(requests, 1);
  await assert.rejects(client.closeSession(), /cleanup outcome is unknown/);
  assert.equal(requests, 1);
});

test("short numeric secrets are redacted without corrupting element numbers or geometry", async () => {
  const { driver, change } = fixture();
  change("PIN 1");
  let observed;
  driver.ask = async state => { observed = state; return { answers: answers({ done: { noul: 1 } }), ms: 0, tokens: 0 }; };
  await driver.do("Observe", { values: { pin: "1" } });
  assert.equal(observed.page.text, "PIN [redacted]");
  assert.equal(observed.task.values.pin, "[redacted]");
  assert.equal(observed.page.elements[0].i, 1);
  assert.equal(observed.page.elements[0].bounds.width, 400);
});

test("targets are immutable, require a device, and cleanup failure retains the device lease", async () => {
  assert.deepEqual(normalizeTarget(), { kind: "web" });
  assert.throws(() => normalizeTarget({ kind: "android" }), /explicit appium:udid/);
  const target = { kind: "android", capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2", "appium:udid": "test-device" } };
  const sessions = new BrowserSessions();
  const a = sessions.create("a", target), b = sessions.create("b", target);
  assert.throws(() => { a.target.kind = "web"; }, TypeError);
  sessions.acquireDevice(a);
  a.session = Promise.resolve({ close: async () => { throw new Error("cleanup failed"); } });
  await assert.rejects(sessions.close(a), /cleanup failed/);
  assert.throws(() => sessions.acquireDevice(b), /already leased/);
});

test("request timeout covers response body, not only response headers", async () => {
  const client = new AppiumClient({ timeoutMs: 20, fetchImpl: async (_, options) => ({ ok: true,
    json: () => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  }) });
  client.sessionId = "own";
  await assert.rejects(client.command("POST", "back", {}, { mutation: true }), error => error.outcome === "unknown");
});

test("external cancellation stops native goals before any action", async () => {
  const { driver, mutations } = fixture();
  driver.execution = { signal: AbortSignal.abort(new Error("cancelled")), remainingActions: 5, remainingCalls: 5 };
  await assert.rejects(driver.do("Open About phone"), /cancelled/);
  assert.equal(mutations.length, 0);
});

test("overlapping lifecycle calls cannot create two sessions or delete twice", async () => {
  let release, count = 0;
  const client = new AppiumClient({ fetchImpl: async () => {
    count++;
    await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ value: { sessionId: "own" } }));
  } });
  const creation = client.createSession({});
  await assert.rejects(client.createSession({}), /already in progress/);
  release();
  await creation;
  const a = client.closeSession(), b = client.closeSession();
  release();
  await Promise.all([a, b]);
  assert.equal(count, 2, "One POST session and one DELETE session");
});
