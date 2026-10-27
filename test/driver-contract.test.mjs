import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAutomationDriver, assertCapability, WEB_CAPABILITIES, WEB_TARGET } from "../src/drivers/contract.mjs";
import { PlaywrightDriver } from "../src/drivers/playwright-driver.mjs";

test("web remains the explicit default target with immutable Playwright capabilities", () => {
  assert.deepEqual(WEB_TARGET, { kind: "web" });
  assert.equal(Object.isFrozen(WEB_CAPABILITIES), true);
  assert.equal(WEB_CAPABILITIES.driver, "playwright");
  assert.equal(WEB_CAPABILITIES.dom, true);
});

test("driver contract reports missing operations", () => {
  assert.throws(() => assertAutomationDriver({}), /open, settle, snapshot, fresh, act, readValue, capabilities, close/);
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
    currentElement: i => { if (i !== 1) throw new Error("missing"); return page.elements[0]; },
    actOn: async args => { events.push(["act", args]); },
    close: async () => events.push(["close"]),
  };
  const driver = new PlaywrightDriver(browser);
  assert.equal(assertAutomationDriver(driver), driver);
  await driver.open("https://example.test/");
  await driver.settle({ quiet: 10 });
  assert.deepEqual(await driver.fresh(page, { target: 1 }), { fresh: true });
  assert.deepEqual(await driver.fresh(page, { target: 2 }), { fresh: false, reason: "target_changed" });
  await driver.act({ tool: "click", target: 1 });
  assert.equal(driver.capabilities(), WEB_CAPABILITIES);
  assert.deepEqual(events[0], ["open", "https://example.test/"]);
  assert.deepEqual(events.at(-1), ["act", { action: "click", element: 1 }]);
});
