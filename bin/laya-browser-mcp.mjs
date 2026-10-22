#!/usr/bin/env node
// MCP server (stdio): one persistent Jev-driven browser session for an LLM client.
//
//   claude mcp add laya-browser -- node /path/to/laya-browser/bin/laya-browser-mcp.mjs
//
// Env: TYPESAFE_API_KEY, JEV_BROWSER_HEADED=1,
//      JEV_BROWSER_PROFILE=/dir (persistent profile, keeps logins), JEV_BROWSER_LOG=1 (rounds to stderr)
//      JEV_BROWSER_VIEWPORT={"width":1280,"height":800} or null (use actual window size)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JevBrowser } from "../src/session.mjs";
import { BACKEND, API_URL, MODEL } from "../src/jev.mjs";
import { runPlan } from "../src/plan.mjs";
import { formatRead } from "../src/prune.mjs";
import { defaultDownloadsDir } from "../src/downloads.mjs";
import { BrowserLease, executeCode, executeShape } from "../src/code-mode.mjs";
import { CODE_API_TYPES, doStep, invokeBrowser, goalShape, planShape, checkShape, chooseShape, readShape, snapshotShape, verifySchema } from "../src/browser-api.mjs";

const backendInfo = { backend: BACKEND, decision_endpoint: API_URL, decision_model: MODEL };

// Holds the launch promise, not the session, so parallel tool calls share one browser.
let session;
let sessionViewport;
const lease = new BrowserLease();
const viewportSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable();
function defaultViewport() {
  const value = process.env.JEV_BROWSER_VIEWPORT;
  if (value === undefined) return { width: 1280, height: 800 };
  try { return viewportSchema.parse(JSON.parse(value)); }
  catch { throw new Error('JEV_BROWSER_VIEWPORT must be null or JSON with positive integer width and height'); }
}
function browser(viewport) {
  if (session && viewport !== undefined && JSON.stringify(viewport) !== JSON.stringify(sessionViewport)) {
    throw new Error("Viewport is a launch setting. Call browser_close, then browser_open with the new viewport.");
  }
  if (!session) {
    sessionViewport = viewport === undefined ? defaultViewport() : viewport;
    session = JevBrowser.launch({ viewport: sessionViewport, headed: process.env.JEV_BROWSER_HEADED === "1", highlight: process.env.JEV_BROWSER_HEADED === "1", userDataDir: process.env.JEV_BROWSER_PROFILE || undefined, downloadsDir: process.env.JEV_BROWSER_DOWNLOADS_DIR || defaultDownloadsDir() })
      .catch(e => { session = undefined; sessionViewport = undefined; throw e; });
  }
  return session;
}
async function closeSession() {
  if (!session) return { pending_downloads: [] };
  const s = session; session = undefined; sessionViewport = undefined;
  return await (await s.catch(() => null))?.close() ?? { pending_downloads: [] };
}
const text = obj => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e).split("\n")[0] }] });
const wrap = fn => async (args, extra) => { try {
  return await lease.run(() => fn(args, extra));
} catch (e) { return fail(e); } };
const stderrLog = process.env.JEV_BROWSER_LOG === "1" ? s => process.stderr.write(s + "\n") : () => {};

const server = new McpServer({ name: "laya-browser", version: "0.1.2" });

server.registerTool("browser_open", {
  title: "Open URL",
  description: "Navigate the browser session to a URL and wait until the page settles. Starts the browser on first use. Optional viewport fixes the page resolution; null follows the browser window size. To change the viewport of an existing session, call browser_close first.",
  inputSchema: {
    url: z.string().describe("Absolute URL"),
    viewport: viewportSchema.optional().describe("Launch viewport: {width,height} in pixels, or null to follow window resizing. Defaults to JEV_BROWSER_VIEWPORT or 1280x800. Close the session before changing it."),
  },
}, wrap(async ({ url, viewport }) => {
  const b = await browser(viewport);
  const r = await b.open(url);
  const page = await b.snapshot();
  return text({ ...r, ...backendInfo, viewport: b.page.viewportSize(), downloads_dir: b.downloads.directory, cache_enabled: !!b.cache, elements: page.elements.length, visible_text: page.text.slice(0, 400) });
}));

server.registerTool("browser_do", {
  title: "Do one browser step",
  description: [
    `Work toward ONE observable outcome on the current page. The configured decision backend (${BACKEND}) picks each element/action/value; it cannot write text or plan, so:`,
    "- Write one outcome per call (\"Log in\", \"Add the Backpack to the cart\", \"Open the Pull requests tab\"); split ordered sub-tasks into separate calls.",
    "- Put every string to type, option to pick or file path to upload in `values`, with meaningful keys ({email, password}).",
    "- Make open-ended goals measurable (\"until at least 3 new results are shown\").",
    "Statuses: done | likely_done (Jev is unsure the goal is met: verify with browser_check or browser_snapshot before moving on) | needs_login (sign-in wall and no credentials given: ask the user to log in, e.g. with JEV_BROWSER_HEADED=1 and JEV_BROWSER_PROFILE, or pass credentials in values) | needs_confirmation (next click looks irreversible: re-call with allow_irreversible=true only if the user wants it) | error (page shows an error) | blocked | stuck | ambiguous (see candidates; use browser_act) | max_actions.",
    "After steps with side effects, use browser_check to confirm nothing unintended changed.",
  ].join("\n"),
  inputSchema: {
    ...goalShape,
    verify: verifySchema.optional().describe("Optional deterministic postconditions"),
    allow_irreversible: z.boolean().optional().describe("Proceed through actions like placing orders, paying, sending, deleting"),
    explain: z.boolean().optional().describe("Include per-round Jev probabilities"),
  },
}, wrap(async ({ goal, values, max_actions, allow_irreversible, explain, verify }) => {
  const b = await browser();
  const r = await doStep(b, { goal, values, max_actions, allow_irreversible, verify }, { log: stderrLog });
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const out = { status: r.status, ...backendInfo, url: r.url, title: r.title, actions, downloads: b.downloads.list(), done_score: r.done_score, decision_calls: r.jev_calls, jev_calls: r.jev_calls, ms: r.ms };
  if (r.cache) out.cache = r.cache;
  for (const k of ["info", "pending", "page_text", "candidates"]) if (r[k]) out[k] = r[k];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...x }) => x);
  return text(out);
}));

server.registerTool("browser_run", {
  title: "Run an ordered browser plan",
  description: "Execute the user's ordered route serially inside the MCP server, with no LLM round trip between successful steps. Obtain the plan and values first. Each step has one observable goal. Returns after all steps finish or on the first non-done status, failed verification, or exception. likely_done also stops. Optional verify checks are deterministic page postconditions. Keeps the browser open. Resume with the failed step and remaining tail, not the completed prefix. Do not call other browser tools while a plan executes.",
  inputSchema: {
    ...planShape,
    viewport: viewportSchema.optional().describe("Launch viewport; null follows the window. Close existing session before changing it."),
  },
}, wrap(async ({ steps, url, viewport }) => {
  const b = await browser(viewport);
  return text({ ...backendInfo, ...await runPlan(b, steps, { url, log: stderrLog }) });
}));

server.registerResource("browser-code-api", "browser://code-mode/api", {
  description: "TypeScript declarations for browser_execute. Programs are JavaScript async function bodies.",
  mimeType: "text/plain",
}, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: CODE_API_TYPES }] }));

server.registerTool("browser_execute", {
  title: "Execute browser Code Mode",
  description: [
    "Execute a JavaScript async function body in an isolated QuickJS/WASM sandbox. The caller LLM writes code; Laya or Jev still decides browser actions.",
    "Use await browser.open({url}), browser.do({goal,values?,max_actions?,verify?}), browser.run({steps,url?}), browser.check({question}), browser.choose({question,options}), browser.read({question,max_chars?}), browser.snapshot({filter?}), browser.downloads({}), browser.waitForDownload({after_id}).",
    "check returns {p_yes}; read returns {content}; snapshot returns {text}. Full TypeScript declarations: browser://code-mode/api.",
    "values is JSON input; return only needed JSON data. No imports, console, Node, filesystem, fetch or raw Playwright. Await every call; browser operations are serial even with Promise.all.",
    "Any non-done status suspends the entire program, including inside try/catch. Inspect suspended and progress; resume only unfinished work. Effects already performed are not rolled back. check/choose probabilities are not deterministic assertions.",
    "Set authorized_goals outside code only for exact irreversible goals the user authorized. A timeout/cancellation during a browser call closes the session to stop pending actions. Do not call other browser tools during execution.",
  ].join("\n"),
  inputSchema: executeShape,
}, wrap(async (args, extra) => {
  let b, calls = 0;
  try {
    const result = await executeCode(args, {
      signal: extra?.signal,
      onAbort: async () => {
        // Cancel Playwright auto-waits immediately, before graceful download draining.
        if (session) await (await session.catch(() => null))?.context.close().catch(() => {});
        await closeSession();
      },
      invoke: async (method, input, policy) => {
        policy.signal.throwIfAborted();
        if (!b) {
          b = await browser(); calls = b.stats.calls;
          b.execution = { signal: policy.signal, remainingCalls: policy.maxDecisionCalls, remainingActions: policy.maxBrowserActions };
        }
        b.assertExecution();
        const result = await invokeBrowser(b, method, input, { ...policy, log: stderrLog });
        b.assertExecution();
        return result;
      },
    });
    return text({ ...backendInfo, ...result, decision_calls: b ? b.stats.calls - calls : 0 });
  } finally { if (b) b.execution = undefined; }
}));

server.registerTool("browser_check", {
  title: "Check page",
  description: "Ask a yes/no question about the current page. Returns the probability of yes (≥0.85 reliable yes, ≤0.15 reliable no, in between: look yourself with browser_snapshot).",
  inputSchema: checkShape,
}, wrap(async ({ question }) => {
  const b = await browser();
  const { p_yes: p } = await invokeBrowser(b, "check", { question });
  return text({ ...backendInfo, question, p_yes: +p.toFixed(3), decision_calls: 1 });
}));

server.registerTool("browser_choose", {
  title: "Choose about page",
  description: "Ask which of several options is true of the current page. Options must be provided (Jev cannot generate text). Returns the choice and a probability per option.",
  inputSchema: chooseShape,
}, wrap(async ({ question, options }) => {
  const b = await browser();
  const r = await invokeBrowser(b, "choose", { question, options });
  return text({ ...backendInfo, decision_calls: 1, choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, +v.toFixed(3)])) });
}));

server.registerTool("browser_snapshot", {
  title: "Page snapshot",
  description: [
    "Compact view of the current page: visible text and numbered interactive elements. Use it to take over when browser_do is ambiguous or stuck, then act with browser_act.",
    "This is the one observation you read in full, so narrow it: `diff` after an action, `filter` when you know what you are looking for, `interactive` when the page's prose does not matter.",
    "Link targets are omitted unless `urls` is true; element numbers, not URLs, are what browser_act takes.",
  ].join("\n"),
  inputSchema: snapshotShape,
}, wrap(async ({ diff, interactive, filter, urls, max_chars }) =>
  text(await (await browser()).snapshotText({ diff: !!diff, interactive: !!interactive, filter: filter ?? "", urls: !!urls, maxChars: max_chars }))));

server.registerTool("browser_act", {
  title: "Act on element",
  description: "Perform one action on an element number from the latest browser_snapshot (or from browser_do candidates). No decision model involved. Numbers are matched to the current page; if the element is gone, take a new snapshot. Confirm/prompt dialogs the action opens are dismissed unless accept_dialog is true.",
  inputSchema: {
    action: z.enum(["click", "type", "press_enter", "press_key", "select", "hover", "right_click", "drag", "upload", "scroll", "back"]),
    element: z.number().int().optional().describe("Element number [i]; not needed for scroll/back/page-level press_key"),
    value: z.string().optional().describe("Text to type, option label to select, or file path to upload"),
    key: z.string().optional().describe("Key for press_key, e.g. Escape"),
    destination: z.number().int().optional().describe("Drop target element number for drag"),
    accept_dialog: z.boolean().optional().describe("Accept a confirm/prompt dialog this action opens (e.g. \"Delete this item?\"). Default: dismiss"),
  },
}, wrap(async ({ accept_dialog, ...args }) => {
  const b = await browser();
  const result = await b.actOn({ ...args, acceptDialog: !!accept_dialog });
  return text({ ...result, downloads: b.downloads.list() });
}));

server.registerTool("browser_downloads", {
  title: "List downloads",
  description: "List files downloaded during this browser session, including completion status and persistent local paths. Optionally return only downloads started after after_id.",
  inputSchema: { after_id: z.string().optional().describe("Return only downloads started after this download ID") },
}, wrap(async ({ after_id }) => {
  const b = await browser();
  return text({ downloads_dir: b.downloads.directory, downloads: b.downloads.list({ afterId: after_id }) });
}));

server.registerTool("browser_wait_for_download", {
  title: "Wait for download",
  description: "Wait for a specific download ID, or for a download newer than after_id. Returns the completed file path or timeout state.",
  inputSchema: {
    id: z.string().optional().describe("Specific download ID to wait for"),
    after_id: z.string().optional().describe("Wait for a download started after this ID; use an empty string for the next download"),
    timeout_ms: z.number().int().min(100).max(300000).optional().describe("Maximum wait in milliseconds; defaults to 30000"),
  },
}, wrap(async ({ id, after_id, timeout_ms }) => {
  if (!id && after_id === undefined) throw new Error("Provide id or after_id to identify the download; use an empty after_id to wait for the next download.");
  const b = await browser();
  return text(await b.downloads.wait({ id, afterId: after_id, timeoutMs: timeout_ms ?? 30000 }));
}));

server.registerTool("browser_screenshot", {
  title: "Screenshot",
  description: "Screenshot of the current page (viewport unless full_page).",
  inputSchema: { full_page: z.boolean().optional() },
}, wrap(async ({ full_page }) => {
  const buf = await (await browser()).screenshot({ fullPage: !!full_page });
  return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
}));

server.registerTool("browser_close", {
  title: "Close browser",
  description: "Close the browser session. The next call starts a fresh one.",
  inputSchema: {},
}, wrap(async () => {
  const result = await closeSession();
  return text({ closed: true, ...result });
}));

server.registerTool("browser_read", {
  title: "Read page content",
  description: [
    "Return the part of the current page's text that helps answer a question. Use it to READ a page; use browser_snapshot to ACT on one.",
    "browser_snapshot only shows the text in the viewport (a long article is ~1% of its content), so this is the way to reach the rest of a document without scrolling and snapshotting it piece by piece.",
    "Code splits the full document into blocks at headings and sections, Jev rates each block against your question, and code returns the ones that help, in document order.",
    "Short pages come back whole with no model call. Long ones are pruned: whatever is left out is counted and marked in place with [… N blocks dropped …], never silently cut. Widen `question` or raise `max_chars` to get more back, or use browser_snapshot for the page as it normally appears.",
    "Costs ~1 s per 50k characters of page text.",
  ].join("\n"),
  inputSchema: readShape,
}, wrap(async ({ question, max_chars }) => {
  const b = await browser();
  const r = await invokeBrowser(b, "read", { question, max_chars });
  return text(formatRead(r));
}));

const shutdown = async () => { await closeSession(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
