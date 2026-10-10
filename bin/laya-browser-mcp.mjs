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

const backendInfo = { backend: BACKEND, decision_endpoint: API_URL, decision_model: MODEL };

// Holds the launch promise, not the session, so parallel tool calls share one browser.
let session;
let sessionViewport;
let planRunning = false;
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
    session = JevBrowser.launch({ viewport: sessionViewport, headed: process.env.JEV_BROWSER_HEADED === "1", highlight: process.env.JEV_BROWSER_HEADED === "1", userDataDir: process.env.JEV_BROWSER_PROFILE || undefined })
      .catch(e => { session = undefined; sessionViewport = undefined; throw e; });
  }
  return session;
}
async function closeSession() {
  if (!session) return;
  const s = session; session = undefined; sessionViewport = undefined;
  await (await s.catch(() => null))?.close();
}
const text = obj => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e).split("\n")[0] }] });
const wrap = fn => async args => { try {
  if (planRunning) throw new Error("A browser_run plan is executing. Wait for it to finish before calling another browser tool.");
  return await fn(args);
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
  return text({ ...r, ...backendInfo, viewport: b.page.viewportSize(), cache_enabled: !!b.cache, elements: page.elements.length, visible_text: page.text.slice(0, 400) });
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
    goal: z.string().describe("One observable outcome"),
    values: z.record(z.string(), z.string()).optional().describe("Named strings Jev may type/select/upload"),
    max_actions: z.number().int().min(1).max(30).optional().describe("Default 10"),
    allow_irreversible: z.boolean().optional().describe("Proceed through actions like placing orders, paying, sending, deleting"),
    explain: z.boolean().optional().describe("Include per-round Jev probabilities"),
  },
}, wrap(async ({ goal, values, max_actions, allow_irreversible, explain }) => {
  const b = await browser();
  const r = await b.do(goal, { values: values ?? {}, maxActions: max_actions ?? 10, allowIrreversible: !!allow_irreversible, log: stderrLog });
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const out = { status: r.status, ...backendInfo, url: r.url, title: r.title, actions, done_score: r.done_score, decision_calls: r.jev_calls, jev_calls: r.jev_calls, ms: r.ms };
  if (r.cache) out.cache = r.cache;
  for (const k of ["info", "pending", "page_text", "candidates"]) if (r[k]) out[k] = r[k];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...x }) => x);
  return text(out);
}));

server.registerTool("browser_run", {
  title: "Run an ordered browser plan",
  description: "Execute the user's ordered route serially inside the MCP server, with no LLM round trip between successful steps. Obtain the plan and values first. Each step has one observable goal. Returns after all steps finish or on the first non-done status, failed verification, or exception. likely_done also stops. Optional verify checks are deterministic page postconditions. Keeps the browser open. Resume with the failed step and remaining tail, not the completed prefix. Do not call other browser tools while a plan executes.",
  inputSchema: {
    url: z.string().optional().describe("Starting URL. Omit to continue the current session."),
    viewport: viewportSchema.optional().describe("Launch viewport; null follows the window. Close existing session before changing it."),
    steps: z.array(z.object({
      goal: z.string().min(1),
      values: z.record(z.string(), z.string()).optional(),
      max_actions: z.number().int().min(1).max(30).optional(),
      allow_irreversible: z.boolean().optional().describe("Only for the specific action authorised by the user"),
      verify: z.object({
        url_includes: z.string().min(1).optional(),
        text_includes: z.string().min(1).optional(),
        field: z.object({ label: z.string().min(1), value_key: z.string().min(1) }).optional()
          .describe("Verify a field by exact label/placeholder against a key in this step's values"),
      }).optional(),
    })).min(1).max(30).describe("Ordered steps executed locally without intermediate LLM responses"),
  },
}, wrap(async ({ steps, url, viewport }) => {
  planRunning = true;
  try {
    const b = await browser(viewport);
    return text({ ...backendInfo, ...await runPlan(b, steps, { url, log: stderrLog }) });
  } finally { planRunning = false; }
}));

server.registerTool("browser_check", {
  title: "Check page",
  description: "Ask a yes/no question about the current page. Returns the probability of yes (≥0.85 reliable yes, ≤0.15 reliable no, in between: look yourself with browser_snapshot).",
  inputSchema: { question: z.string() },
}, wrap(async ({ question }) => {
  const b = await browser();
  const p = await b.check(question);
  return text({ ...backendInfo, question, p_yes: +p.toFixed(3), decision_calls: 1 });
}));

server.registerTool("browser_choose", {
  title: "Choose about page",
  description: "Ask which of several options is true of the current page. Options must be provided (Jev cannot generate text). Returns the choice and a probability per option.",
  inputSchema: { question: z.string(), options: z.array(z.string()).min(2).max(255) },
}, wrap(async ({ question, options }) => {
  const b = await browser();
  const r = await b.choose(question, options);
  return text({ ...backendInfo, decision_calls: 1, choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, +v.toFixed(3)])) });
}));

server.registerTool("browser_snapshot", {
  title: "Page snapshot",
  description: [
    "Compact view of the current page: visible text and numbered interactive elements. Use it to take over when browser_do is ambiguous or stuck, then act with browser_act.",
    "This is the one observation you read in full, so narrow it: `diff` after an action, `filter` when you know what you are looking for, `interactive` when the page's prose does not matter.",
    "Link targets are omitted unless `urls` is true; element numbers, not URLs, are what browser_act takes.",
  ].join("\n"),
  inputSchema: {
    diff: z.boolean().optional().describe("Only what changed since the previous snapshot (falls back to a full one if there is none). Carries no element numbers: take a full snapshot to act."),
    interactive: z.boolean().optional().describe("Drop the visible-text block and list only elements (dialog/status text is kept)"),
    filter: z.string().optional().describe("Keep only elements whose label/text/placeholder/name/href contains this substring, case-insensitive"),
    urls: z.boolean().optional().describe("Print href= on element lines. Default false"),
    max_chars: z.number().int().min(200).optional().describe("Size limit of the rendered snapshot. Default 10000, capped at 20000"),
  },
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
}, wrap(async ({ accept_dialog, ...args }) => text(await (await browser()).actOn({ ...args, acceptDialog: !!accept_dialog }))));

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
  await closeSession();
  return text({ closed: true });
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
  inputSchema: {
    question: z.string().describe("What you want to learn from the page; blocks are kept or dropped against this"),
    max_chars: z.number().int().min(500).max(200_000).optional().describe("Character budget for the content returned. Default 12000"),
  },
}, wrap(async ({ question, max_chars }) => {
  const b = await browser();
  const r = await b.read(question, max_chars ? { budgetChars: max_chars } : {});
  return text(formatRead(r));
}));

const shutdown = async () => { await closeSession(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
