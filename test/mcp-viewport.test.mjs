// Offline MCP integration: viewport launch settings and actual screenshot sizes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const server = fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url));
const url = "data:text/html,<title>Viewport fixture</title><body>Viewport fixture</body>";

test("MCP viewport supports explicit sizes, null, environment defaults, and validation", async () => {
  const client = new Client({ name: "viewport-test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server],
    env: { ...process.env, JEV_BROWSER_HEADED: "0", JEV_BROWSER_PROFILE: "", JEV_BROWSER_VIEWPORT: '{"width":900,"height":600}', JEV_CACHE: "0" } }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const open = async args => {
    const r = await call("browser_open", { url, ...args });
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  const screenshotSize = async () => {
    const r = await call("browser_screenshot");
    assert.ok(!r.isError);
    const png = Buffer.from(r.content[0].data, "base64");
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  };
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(t => t.name === "browser_open").inputSchema.properties.viewport);
    const fixed = { width: 1280, height: 800 };
    assert.deepEqual((await open({ viewport: fixed })).viewport, fixed);
    assert.deepEqual(await screenshotSize(), fixed);
    assert.deepEqual((await open({})).viewport, fixed, "omitting viewport preserves the session setting");
    const changed = await call("browser_open", { url, viewport: null });
    assert.ok(changed.isError);
    assert.match(changed.content[0].text, /browser_close/);
    assert.deepEqual(await screenshotSize(), fixed, "failed reconfiguration preserves the existing session");
    await call("browser_close");
    assert.equal((await open({ viewport: null })).viewport, null);
    const responsive = await screenshotSize();
    assert.ok(responsive.width > 0 && responsive.height > 0);
    await call("browser_close");
    const defaults = { width: 900, height: 600 };
    assert.deepEqual((await open({})).viewport, defaults);
    assert.deepEqual(await screenshotSize(), defaults);
    const invalid = await call("browser_open", { url, viewport: { width: 0, height: 800 } });
    assert.ok(invalid.isError, "reject nonpositive sizes");
  } finally { await call("browser_close"); await client.close(); }
});
