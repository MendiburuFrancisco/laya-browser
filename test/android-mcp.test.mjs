import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
const xml = `<hierarchy><node class="android.widget.TextView" text="About phone" bounds="[0,20][300,90]" visible-to-user="true" enabled="true" clickable="true" checked="false" selected="false"/></hierarchy>`;

test("MCP Android target opens, observes, gates web capabilities and owns device/session", { timeout: 30000 }, async () => {
  const calls = [];
  const appium = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/session") return res.end(JSON.stringify({ value: { sessionId: "android-test-1", capabilities: {} } }));
    if (req.method === "GET" && req.url === "/session/android-test-1/source") return res.end(JSON.stringify({ value: xml }));
    if (req.method === "GET" && req.url === "/session/android-test-1/appium/device/current_package") return res.end(JSON.stringify({ value: "com.android.settings" }));
    if (req.method === "GET" && req.url === "/session/android-test-1/appium/device/current_activity") return res.end(JSON.stringify({ value: ".Settings" }));
    if (req.method === "DELETE" && req.url === "/session/android-test-1") return res.end(JSON.stringify({ value: null }));
    res.statusCode = 404;
    res.end(JSON.stringify({ value: { error: "unknown command", message: "not implemented" } }));
  });
  appium.listen(0, "127.0.0.1");
  await once(appium, "listening");
  const appiumUrl = `http://127.0.0.1:${appium.address().port}`;
  const client = new Client({ name: "android-contract-test", version: "0" });
  const env = { ...process.env, JEV_BACKEND: "laya" };
  env.JEV_BROWSER_VIDEO_DIR = "web-only-video-default";
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env }));
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const reply = await raw(name, args);
    assert.ok(!reply.isError, reply.content[0]?.text);
    return JSON.parse(reply.content[0].text);
  };
  const target = {
    kind: "android", appium_url: appiumUrl,
    capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2", "appium:udid": "emulator-test", "appium:noReset": true },
  };
  try {
    const created = await call("browser_create_session", { session_id: "android-contract", target });
    assert.equal(created.target, "android");
    assert.equal((await raw("browser_create_session", { target: { kind: "android" } })).isError, true);
    const opened = await call("browser_open", { session_id: "android-contract", app: { package: "com.android.settings", activity: ".Settings" } });
    assert.equal(opened.package, "com.android.settings");
    assert.equal(opened.capabilities.dom, false);
    const snapshot = await raw("browser_snapshot", { session_id: "android-contract" });
    assert.match(snapshot.content[0].text, /About phone/);
    assert.match(snapshot.content[0].text, /actions=\[click\]/);
    const html = await raw("browser_get_html", { session_id: "android-contract" });
    assert.equal(html.isError, true);
    assert.match(html.content[0].text, /unsupported_capability/);
    for (const [name, args] of [["browser_list_tabs", {}], ["browser_downloads", {}], ["browser_videos", {}], ["browser_screenshot", {}], ["list_network_requests", {}], ["browser_webmcp_tools", {}]]) {
      const unsupported = await raw(name, { ...args, session_id: "android-contract" });
      assert.equal(unsupported.isError, true, name);
      assert.match(unsupported.content[0].text, /unsupported_capability/, name);
    }
    const read = await raw("browser_read", { session_id: "android-contract", question: "Visible text" });
    assert.match(read.content[0].text, /About phone/);
    const second = await call("browser_create_session", { session_id: "android-second", target });
    assert.equal(second.target, "android");
    const concurrent = await raw("browser_open", { session_id: "android-second", app: { package: "com.android.settings" } });
    assert.equal(concurrent.isError, true);
    assert.match(concurrent.content[0].text, /already leased/);
    assert.equal(calls.filter(call => call === "POST /session").length, 1);
    await call("browser_close", { session_id: "android-contract" });
    assert.equal(calls.filter(call => call === "DELETE /session/android-test-1").length, 1);
    const code = await call("browser_execute", { session_id: "android-second", code: "const opened = await browser.open({app:{package:'com.android.settings',activity:'.Settings'}}); const snapshot = await browser.snapshot({}); return {opened,snapshot};" });
    assert.equal(code.status, "done", code.info);
    assert.match(code.result.snapshot.text, /About phone/);
    const gated = await call("browser_execute", { session_id: "android-second", code: "return await browser.getHtml({});" });
    assert.equal(gated.status, "error");
    assert.match(gated.info, /unsupported capability: dom/);
  } finally {
    await raw("browser_close", { session_id: "android-contract" });
    await raw("browser_close", { session_id: "android-second" });
    await client.close();
    await new Promise(resolve => appium.close(resolve));
  }
});
