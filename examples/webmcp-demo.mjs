#!/usr/bin/env node
// WebMCP demo: a local todo page registers its own tools; the MCP server finds and calls them.
// The goals are plain browser_do steps: Jev sees the page's tools next to its buttons and chooses
// to call them, filling arguments from `values`. The page's code does the work.
//
//   node examples/webmcp-demo.mjs            # headed, paced for watching
//   STEP_MS=0 node examples/webmcp-demo.mjs  # as fast as it goes
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STEP_MS = +(process.env.STEP_MS ?? 1500);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Todos · WebMCP</title><style>
  body { font: 16px/1.5 system-ui; margin: 0; display: grid; grid-template-columns: 1fr 420px; min-height: 100vh; background: #f6f6f4; color: #1d1d1b; }
  main { padding: 48px; } h1 { margin: 0 0 4px; } .sub { color: #6b6b66; margin: 0 0 24px; }
  ul { list-style: none; padding: 0; max-width: 460px; } li { background: #fff; border: 1px solid #e3e3df; border-radius: 8px; padding: 12px 14px; margin: 8px 0; display: flex; gap: 10px; align-items: center; animation: in .3s; }
  form { display: flex; gap: 8px; max-width: 460px; } input[type=text] { flex: 1; font: inherit; padding: 10px 12px; border: 1px solid #d3d3ce; border-radius: 8px; }
  button { font: 600 14px system-ui; padding: 8px 14px; border: 0; border-radius: 8px; background: #1d1d1b; color: #fff; cursor: pointer; }
  li button { margin-left: auto; background: #ecebe7; color: #1d1d1b; } li.done button { visibility: hidden; }
  button.flash { animation: flash 1.2s; } @keyframes flash { 0%, 60% { box-shadow: 0 0 0 4px #7c6cf0; background: #7c6cf0; color: #fff; } }
  li.done span { text-decoration: line-through; color: #9a9a94; } .empty { color: #9a9a94; }
  aside { background: #16161a; color: #d8d8de; padding: 24px; font: 13px/1.45 ui-monospace, monospace; overflow: auto; }
  aside h2 { font: 600 12px system-ui; letter-spacing: .08em; text-transform: uppercase; color: #8a8a96; margin: 0 0 12px; }
  .call { border-left: 3px solid #7c6cf0; padding: 6px 10px; margin: 0 0 10px; background: #1f1f26; border-radius: 0 6px 6px 0; animation: in .3s; }
  .call b { color: #b7adff; } .call .ret { color: #7fd1a3; }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } }
</style></head><body>
<main><h1>Todos</h1><p class="sub">The buttons are for people. The same actions are registered as WebMCP tools, which an agent calls directly; the button it stands in for flashes.</p><form id="add"><input id="text" type="text" placeholder="What needs to be done?" aria-label="New todo"><button id="addBtn">Add</button></form><ul id="list"><li class="empty">Nothing yet</li></ul></main>
<aside><h2>WebMCP calls from the agent</h2><div id="log"></div></aside>
<script>
  const todos = [];
  const render = () => {
    list.innerHTML = todos.length ? "" : '<li class="empty">Nothing yet</li>';
    for (const t of todos) { const li = document.createElement("li"); li.className = t.done ? "done" : ""; li.innerHTML = '<input type="checkbox" aria-label="Toggle ' + t.text + '"' + (t.done ? " checked" : "") + '><span></span><button>Done</button>'; li.querySelector("span").textContent = t.text; li.querySelector("button").onclick = () => complete(t.text); li.querySelector("button").dataset.todo = t.text; list.append(li); }
  };
  const add = text => { todos.push({ text, done: false }); render(); return "added \\"" + text + "\\" (" + todos.length + " total)"; };
  const complete = text => { const t = todos.find(t => t.text === text); if (!t) return "no todo \\"" + text + "\\""; t.done = true; render(); return "completed \\"" + text + "\\""; };
  document.getElementById("add").onsubmit = e => { e.preventDefault(); const v = text.value.trim(); if (v) add(v); text.value = ""; };
  // a tool call flashes the button it stands in for
  const flash = el => { if (!el) return; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); };
  const logged = (name, fn) => async args => {
    const r = await fn(args);
    const d = document.createElement("div"); d.className = "call";
    d.innerHTML = "<b></b><div></div><div class=ret></div>";
    d.children[0].textContent = name; d.children[1].textContent = JSON.stringify(args); d.children[2].textContent = "→ " + r;
    log.prepend(d);
    return { content: [{ type: "text", text: r }] };
  };
  const mc = document.modelContext;
  mc.registerTool({ name: "add_todo", description: "Add a todo item", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: logged("add_todo", ({ text }) => { const r = add(text); flash(addBtn); return r; }) });
  mc.registerTool({ name: "complete_todo", description: "Mark a todo item done, by its text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: logged("complete_todo", ({ text }) => { const btn = [...list.querySelectorAll("button")].find(b => b.dataset.todo === text); flash(btn); return new Promise(r => setTimeout(() => r(complete(text)), 700)); }) });
  mc.registerTool({ name: "list_todos", description: "List todo items and whether each is done", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} },
    execute: logged("list_todos", () => JSON.stringify(todos)) });
</script></body></html>`;

const http = createServer((_, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
await new Promise(r => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;

const server = fileURLToPath(new URL("../bin/jev-browser-mcp.mjs", import.meta.url));
const client = new Client({ name: "webmcp-demo", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { JEV_BROWSER_HEADED: "1", ...process.env } }));

async function call(name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(`\n> ${name} ${JSON.stringify(args)}  (${Date.now() - t} ms)${r.isError ? "  ERROR" : ""}\n${text}`);
  if (r.isError) throw new Error(text);
  await sleep(STEP_MS);
  return JSON.parse(text);
}

try {
  const opened = await call("browser_open", { url });
  if (!opened.webmcp_tools?.includes("add_todo")) throw new Error("page tools not found");
  // Plain goals, as Claude would write them. Jev sees the page's tools next to its buttons and picks.
  const steps = [
    ["Add 'buy milk' to the todo list", { todo: "buy milk" }],
    ["Add 'walk the dog' to the todo list", { todo: "walk the dog" }],
    ["Mark 'buy milk' as done", { todo: "buy milk" }],
  ];
  let viaTools = 0;
  for (const [goal, values] of steps) {
    const r = await call("browser_do", { goal, values });
    if (r.status !== "done") throw new Error(`${goal}: ${r.status}`);
    viaTools += r.actions.filter(a => a.startsWith("webmcp")).length;
  }
  const p = await call("browser_check", { question: "Is 'buy milk' crossed out as done while 'walk the dog' is not?" });
  const ok = p.p_yes > 0.6 && viaTools >= 3;
  console.log(`\nWebMCP demo ${ok ? "passed" : "FAILED"}: ${viaTools} page-tool calls chosen by Jev, p_yes ${p.p_yes}`);
  await sleep(STEP_MS);
  await call("browser_close");
  if (!ok) process.exitCode = 1;
} finally {
  await client.close(); http.close();
}
