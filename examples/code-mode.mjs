// Real-backend smoke: uses the configured JEV_BACKEND (jev or laya), stdio MCP,
// Chromium and DOM postconditions. Laya must be running; Jev needs an API key.
// node --env-file=.env examples/code-mode.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "code-mode-example", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL("../bin/laya-browser-mcp.mjs", import.meta.url))],
  env: { ...process.env, JEV_CACHE: "0", JEV_BROWSER_PROFILE: "" },
}));
try {
  const response = await client.callTool({ name: "browser_execute", arguments: {
    values: { url: "data:text/html," + encodeURIComponent('<title>Code Mode demo</title><label for="name">Name</label><input id="name">'),
      names: ["Ada", "Grace"] },
    timeout_ms: 120000,
    code: `
      await browser.open({url: values.url});
      const completed = [];
      for (const name of values.names) {
        await browser.do({
          goal: "Enter the supplied name into the Name field without submitting",
          values: {name},
          verify: {field: {label: "Name", value_key: "name"}}
        });
        completed.push(name);
      }
      return {completed};
    `,
  } }, undefined, { timeout: 150000 });
  assert.ok(!response.isError, response.content[0]?.text);
  const result = JSON.parse(response.content[0].text);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.status, "done", "Inspect suspended/progress if the backend needs intervention");
  assert.deepEqual(result.result.completed, ["Ada", "Grace"]);
  assert.ok(result.decision_calls > 0, "Decisions must reach the configured real backend");
} finally {
  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await client.close();
}
