import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAutomationDriver, assertCapability, assertFreshness, assertObservation, WEB_CAPABILITIES, WEB_TARGET } from "../src/drivers/contract.mjs";
import { PlaywrightDriver } from "../src/drivers/playwright-driver.mjs";
import { AppiumAndroidDriver } from "../src/drivers/appium/driver.mjs";
import { JevBrowser } from "../src/session.mjs";

test("web remains the explicit default target with immutable Playwright capabilities", () => {
  assert.deepEqual(WEB_TARGET, { kind: "web" });
  assert.equal(Object.isFrozen(WEB_CAPABILITIES), true);
  assert.equal(WEB_CAPABILITIES.driver, "playwright");
  assert.equal(WEB_CAPABILITIES.dom, true);
});

test("driver contract reports missing operations", () => {
  assert.throws(() => assertAutomationDriver({}), /open, settle, snapshot, actionSpace, fresh, act, readValue, capabilities, close/);
});

test("observations, action spaces and freshness results are typed", () => {
  const page = { url: "app://demo/.Main", elements: [{ i: 1, actions: ["click"] }] };
  assert.equal(assertObservation(page), page);
  assert.deepEqual(assertFreshness({ fresh: false, reason: "target_missing" }), { fresh: false, reason: "target_missing" });
  assert.throws(() => assertObservation({ url: "app://demo/.Main", elements: [{ i: 1, actions: "click" }] }), /actions/);
  assert.throws(() => assertFreshness({ fresh: false, reason: "unknown" }), /reason/);
});

test("unsupported capabilities have a structured error", () => {
  assert.throws(() => assertCapability({ dom: false }, "dom"), error => {
    assert.equal(error.code, "unsupported_capability");
    assert.equal(error.capability, "dom");
    return true;
  });
});

test("Playwright adapter delegates existing web operations and returns typed freshness", async () => {
  const events = [];
  const page = { url: "https://example.test/", elements: [{ i: 1, text: "Save" }] };
  const browser = {
    open: async url => { events.push(["open", url]); },
    settle: async options => events.push(["settle", options]),
    snapshot: async () => page,
    actionSpace: () => ["click", "wait", "none"],
    currentElement: i => { if (i !== 1) throw new Error("missing"); return page.elements[0]; },
    execute: async args => { events.push(["act", args]); },
    close: async () => events.push(["close"]),
  };
  const driver = new PlaywrightDriver(browser);
  assert.equal(assertAutomationDriver(driver), driver);
  await driver.open("https://example.test/");
  await driver.settle({ quiet: 10 });
  assert.deepEqual(await driver.fresh(page, { target: 1 }), { fresh: true });
  assert.deepEqual(await driver.fresh(page, { target: 2 }), { fresh: false, reason: "target_missing" });
  await driver.act({ tool: "click", target: 1 });
  assert.equal(driver.capabilities(), WEB_CAPABILITIES);
  assert.deepEqual(events[0], ["open", "https://example.test/"]);
  assert.deepEqual(events.at(-1), ["act", { tool: "click", target: 1 }]);
});

test("web freshness distinguishes a missing target from a changed target", async () => {
  const previous = { url: "https://example.test/", elements: [{ i: 1, text: "Save" }] };
  const current = { url: "https://example.test/", elements: [] };
  const browser = {
    snapshot: async () => current,
    currentElement: () => { throw new Error("missing"); },
  };
  const driver = new PlaywrightDriver(browser);
  assert.deepEqual(await driver.fresh(previous, { target: 1 }), { fresh: false, reason: "target_missing" });
  current.elements = [{ i: 1, text: "Save" }];
  assert.deepEqual(await driver.fresh(previous, { target: 1 }), { fresh: false, reason: "target_changed" });
});

test("Android contract publishes observed actions and act executes once without policy side effects", async () => {
  const mutations = [];
  const element = { i: 1, actions: ["click"], _native: { xpath: "//node[@bounds='[0,0][10,10]']" } };
  const client = {
    findElement: async () => "element-1",
    elementCommand: async (...args) => { mutations.push(args); },
  };
  const driver = new AppiumAndroidDriver({ client });
  driver.consumeAction = () => { throw new Error("hidden action budget"); };
  driver.fresh = () => { throw new Error("hidden freshness cycle"); };
  assert.deepEqual(driver.actionSpace({ elements: [element] }), ["click", "back", "wait", "none"]);
  await driver.act({ tool: "click", target: 1 }, { element });
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0][2], "click");
});

for (const platform of ["web", "android"]) {
  test(`${platform} shares freshness semantics for screen, changed target and missing target`, async () => {
    const previous = { url: "test://screen", text: "Static", fingerprint: "same", elements: [
      { i: 1, tag: "button", label: "Continue", enabled: true, actions: ["click"] },
    ] };
    let current = structuredClone(previous);
    const browser = { snapshot: async () => structuredClone(current), currentElement: JevBrowser.prototype.currentElement };
    const driver = platform === "web" ? new PlaywrightDriver(browser) : new AppiumAndroidDriver({ client: {} });
    if (platform === "android") driver.snapshot = async () => structuredClone(current);
    assert.equal((await driver.fresh(previous, { tool: "click", target: 1 })).fresh, true);
    current.elements[0].enabled = false;
    assert.equal((await driver.fresh(previous, { tool: "click", target: 1 })).reason, "target_changed");
    current.elements = [];
    assert.equal((await driver.fresh(previous, { tool: "click", target: 1 })).reason, "target_missing");
    current.url = "test://other-screen";
    assert.equal((await driver.fresh(previous, { tool: "click", target: 1 })).reason, "page_changed");
  });
}

test("web freshness remaps indices only when both source and destination states remain unchanged", async () => {
  const previous = { url: "test://screen", text: "", elements: [
    { i: 1, tag: "input:checkbox", label: "Enable", checked: false },
    { i: 2, tag: "button", label: "Drop", disabled: false },
  ] };
  const current = structuredClone(previous);
  current.elements[0].i = 7;
  current.elements[1].i = 9;
  const driver = new PlaywrightDriver({ snapshot: async () => structuredClone(current), currentElement: JevBrowser.prototype.currentElement });
  const action = { tool: "drag", target: 1, destination: 2 };
  assert.equal((await driver.fresh(previous, action)).fresh, true);
  assert.deepEqual(action, { tool: "drag", target: 7, destination: 9 });
  current.elements[0].checked = true;
  assert.equal((await driver.fresh(previous, { tool: "drag", target: 1, destination: 2 })).reason, "target_changed");
  current.elements[0].checked = false;
  current.elements[1].disabled = true;
  assert.equal((await driver.fresh(previous, { tool: "drag", target: 1, destination: 2 })).reason, "target_changed");
});
