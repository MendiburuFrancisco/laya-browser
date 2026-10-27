// Opt-in only: a dedicated emulator and a running Appium UiAutomator2 server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AppiumAndroidDriver } from "../src/drivers/appium/driver.mjs";
import { verifyStep } from "../src/plan.mjs";

const enabled = process.env.JEV_ANDROID_E2E === "1";
const capabilities = { platformName: "Android", "appium:automationName": "UiAutomator2",
  "appium:udid": process.env.ANDROID_UDID ?? "emulator-5554", "appium:noReset": true, "appium:forceAppLaunch": true };
const app = { package: "com.android.settings", activity: ".Settings" };

test("real Android scroll, About phone, back, type and clear", { skip: !enabled, timeout: 180000 }, async () => {
  const driver = new AppiumAndroidDriver({ capabilities });
  try {
    await driver.open(app);
    let page, about;
    for (let count = 0; count < 7; count++) {
      await driver.snapshotText();
      page = driver.shown;
      about = page.elements.find(e => e.actions.includes("click") && /^About (phone|emulated device)/i.test(e.label));
      if (about) break;
      const scroll = page.elements.find(e => e.actions.includes("scroll"));
      assert.ok(scroll, "A scroll container is published");
      await driver.actOn({ action: "scroll", element: scroll.i, value: "down" });
    }
    assert.ok(about, "About phone is reachable through observed scrolls");
    await driver.actOn({ action: "click", element: about.i });
    assert.equal(await verifyStep(driver, { verify: { app_package: app.package, text_includes: "Device name" } }), true);
    console.log(JSON.stringify({ checkpoint: "about_phone", url: driver.currentUrl, elements: driver.lastPage.elements.length }));
    await driver.actOn({ action: "back" });
    // Bring the homepage search control back into view without changing settings.
    await driver.snapshotText();
    let search = driver.shown.elements.find(e => e.actions.includes("click") && /Search Settings/i.test(e.label));
    if (!search) {
      await driver.actOn({ action: "scroll", value: "up" });
      await driver.snapshotText();
      search = driver.shown.elements.find(e => e.actions.includes("click") && /Search Settings/i.test(e.label));
    }
    assert.ok(search, "Settings search is observed");
    await driver.actOn({ action: "click", element: search.i });
    await driver.snapshotText();
    const input = driver.shown.elements.find(e => e.actions.includes("type"));
    assert.ok(input, "Search exposes an editable accessibility element");
    await driver.actOn({ action: "type", element: input.i, value: "About phone" });
    await driver.snapshotText();
    const typed = driver.shown.elements.find(e => e.actions.includes("clear"));
    assert.ok(typed);
    assert.equal(await driver.readValue(typed), "About phone");
    let didClear = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await driver.snapshotText();
      const current = driver.shown.elements.find(e => e.actions.includes("clear"));
      try { await driver.actOn({ action: "clear", element: current.i }); didClear = true; break; }
      catch (error) { if (!/is stale \(page_changed\)/.test(error.message)) throw error; }
    }
    assert.equal(didClear, true, "Clear uses a new observation if asynchronous search results invalidate the prior decision");
    await driver.snapshotText();
    const cleared = driver.shown.elements.find(e => e.actions.includes("type"));
    assert.equal(await driver.readValue(cleared), "");
    console.log(JSON.stringify({ checkpoint: "search_type_clear", verified: true }));
  } finally { await driver.close(); }
});

test("real Jev goal through MCP Code Mode with independent postconditions", {
  skip: !enabled || process.env.JEV_ANDROID_JEV_E2E !== "1", timeout: 240000,
}, async () => {
  const client = new Client({ name: "android-e2e", version: "0" });
  const env = { ...process.env, JEV_BACKEND: "jev" };
  delete env.JEV_BROWSER_VIDEO_DIR;
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url))], env }));
  let session;
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: { ...args, ...(session ? { session_id: session } : {}) } }, undefined, { timeout: 240000 });
    assert.ok(!response.isError, response.content[0]?.text);
    return JSON.parse(response.content[0].text);
  };
  try {
    session = (await call("browser_create_session", { target: { kind: "android", appium_url: process.env.APPIUM_URL ?? "http://127.0.0.1:4723", capabilities } })).session_id;
    const result = await call("browser_execute", { timeout_ms: 220000, code:
      `return await browser.run({app:values.app,steps:[{goal:'Open the About phone screen showing Device name and device model. Scroll down through Settings if necessary.',max_actions:10,verify:{app_package:'com.android.settings',text_includes:'Device name'}}]});`, values: { app } });
    assert.equal(result.status, "done", JSON.stringify(result));
    assert.equal(result.result.status, "done", JSON.stringify(result));
    assert.equal(result.result.completed, 1);
    console.log(JSON.stringify({ checkpoint: "jev_mcp_code_mode", ...result.result }));
  } finally {
    if (session) await call("browser_close");
    await client.close();
  }
});
