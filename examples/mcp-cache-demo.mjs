// Talks to laya-browser over MCP stdio exactly like opencode does: spawns the server,
// calls browser_open + browser_do, twice (two server processes, same cache file).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = async n => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["bin/laya-browser-mcp.mjs"],
    env: { ...process.env, JEV_CACHE_FILE: "/tmp/opencode/mcp-cache.json", JEV_BROWSER_HEADED: "0" },
    stderr: "inherit",
  });
  const client = new Client({ name: "demo", version: "0.0.1" });
  await client.connect(transport);

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content[0].text);
  };

  await call("browser_open", { url: "https://test-patient-web.wehealthy.ar" });
  const r = await call("browser_do", {
    goal: "Click 'Iniciar sesión', fill in the login form and submit it",
    values: { email: process.env.WEHEALTHY_EMAIL, password: process.env.WEHEALTHY_PASSWORD },
  });
  console.log(`=== MCP RUN ${n}: status=${r.status} jev_calls=${r.jev_calls} cache=${JSON.stringify(r.cache ?? null)} url=${r.url}`);

  await client.callTool({ name: "browser_close", arguments: {} }).catch(() => {});
  await client.close();
  await transport.close();
};

await run(1);   // fresh server, empty cache -> Jev decides, persists
await run(2);   // fresh server, warm cache -> replays without Jev
process.exit(0);
