#!/usr/bin/env node
// MCP server (stdio): isolated browser sessions selected explicitly by each caller.
//
//   claude mcp add laya-browser -- node /path/to/laya-browser/bin/laya-browser-mcp.mjs
//
// Env: TYPESAFE_API_KEY, JEV_BROWSER_HEADED=1,
//      JEV_BROWSER_PROFILE=/dir (persistent profile, keeps logins), JEV_BROWSER_LOG=1 (rounds to stderr)
//      JEV_BROWSER_VIEWPORT={"width":1280,"height":800} or null (use actual window size)
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JevBrowser } from "../src/session.mjs";
import { BACKEND, API_URL, MODEL, credentials } from "../src/jev.mjs";
import { runPlan } from "../src/plan.mjs";
import { formatRead } from "../src/prune.mjs";
import { defaultDownloadsDir } from "../src/downloads.mjs";
import { executeCode, executeShape } from "../src/code-mode.mjs";
import { BrowserSessions } from "../src/browser-sessions.mjs";
import { LocatorCache } from "../src/locator-cache.mjs";
import { errorDiagnostic } from "../src/diagnostics.mjs";
import { CODE_API_TYPES, doStep, invokeBrowser, goalShape, planShape, checkShape, chooseShape, readShape, snapshotShape, verifySchema, networkListShape, networkGetShape, recordVideoSchema, tabSelectShape, tabNewShape, boxShape, actBoxShape } from "../src/browser-api.mjs";

process.env.JEV_BROWSER_MCP = "1";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const backendInfo = () => {
  let provider = { url: API_URL, model: MODEL };
  if (BACKEND === "jev") { try { provider = credentials(); } catch {} }
  return { backend: BACKEND, decision_endpoint: provider.url, decision_model: provider.model };
};
const HEADED = /^(1|true)$/i.test(process.env.JEV_BROWSER_HEADED ?? "");
async function installChromium() {
  const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
  process.stderr.write("laya-browser: Chromium for Playwright is missing, installing it (one time)\n");
  await promisify(execFile)(process.execPath, [cli, "install", "chromium"], { timeout: 600_000 });
}

const sessions = new BrowserSessions();
const sessionScope = new AsyncLocalStorage();
const currentSession = () => sessionScope.getStore();
const viewportSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable();
function defaultViewport() {
  const value = process.env.JEV_BROWSER_VIEWPORT;
  if (value === undefined) return { width: 1280, height: 800 };
  try { return viewportSchema.parse(JSON.parse(value)); }
  catch { throw new Error('JEV_BROWSER_VIEWPORT must be null or JSON with positive integer width and height'); }
}
function defaultVideo() {
  const dir = process.env.JEV_BROWSER_VIDEO_DIR;
  if (dir === undefined) return null;
  if (!dir.trim()) throw new Error("Video recording configuration error: JEV_BROWSER_VIDEO_DIR is set but empty. Set it to a writable directory or unset it to disable automatic recording.");
  return { dir };
}
async function browser(viewport, recordVideo) {
  const entry = currentSession();
  try {
  if (entry.session && recordVideo !== undefined && JSON.stringify(recordVideo) !== JSON.stringify(entry.video)) {
      throw new Error("Video recording is a launch setting. Call browser_close, then browser_open with record_video.");
    }
  if (entry.session && viewport !== undefined && JSON.stringify(viewport) !== JSON.stringify(entry.viewport)) {
      throw new Error("Viewport is a launch setting. Call browser_close, then browser_open with the new viewport.");
    }
  if (!entry.session) {
    entry.viewport = viewport === undefined ? defaultViewport() : viewport;
    entry.video = recordVideo === undefined ? defaultVideo() : recordVideo;
    const isolatedPath = base => entry.id === "default" ? base : join(base, "sessions", sessions.namespace, entry.id);
    const video = entry.video ? { ...entry.video, dir: isolatedPath(entry.video.dir) } : undefined;
    const launch = async () => {
      const b = await JevBrowser.launch({ viewport: entry.viewport, recordVideo: video, headed: HEADED, highlight: HEADED,
        userDataDir: process.env.JEV_BROWSER_PROFILE ? isolatedPath(process.env.JEV_BROWSER_PROFILE) : undefined,
        downloadsDir: isolatedPath(process.env.JEV_BROWSER_DOWNLOADS_DIR || defaultDownloadsDir()) });
      if (b.cache && entry.id !== "default") {
        const file = process.env.JEV_CACHE_FILE || ".laya-cache.json";
        b.cache = new LocatorCache(join(isolatedPath(dirname(file)), basename(file)));
      }
      return b;
    };
    entry.session = launch()
        .catch(async e => {
          if (!/not installed/.test(e.message) || process.env.JEV_BROWSER_NO_INSTALL === "1") throw e;
          await installChromium();
          return launch();
        })
      .catch(e => { entry.session = undefined; entry.viewport = undefined; entry.video = undefined; throw e; });
    }
   return await entry.session;
  } catch (error) {
    error.diagnostic = errorDiagnostic(error, { phase: "browser_launch" });
    throw error;
  }
}
async function closeSession() {
  return sessions.close(currentSession());
}
const text = obj => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify({ ...obj, ...(currentSession() ? { session_id: currentSession().id } : {}) }, null, 1) }] });
const fail = e => ({ isError: true, ...text({ status: e?.status ?? "error", info: errorDiagnostic(e).message, error: e?.diagnostic ?? errorDiagnostic(e) }) });
const wrap = fn => async (args, extra) => { try {
  const { session_id, ...input } = args;
  const entry = sessions.resolve(session_id);
  return await sessionScope.run(entry, () => entry.lease.run(() => fn(input, extra)));
} catch (e) { return fail(e); } };
const stderrLog = process.env.JEV_BROWSER_LOG === "1" ? s => process.stderr.write(s + "\n") : () => {};

const server = new McpServer({ name: "laya-browser", version });

// Add the selector centrally so no direct tool can accidentally bypass isolation.
const registerBrowserTool = (name, config, handler) => server.registerTool(name, {
  ...config,
  description: config.description + " Pass your session_id on every call; obtain a unique id with browser_create_session for each conversation. No global active-session selection.",
  inputSchema: { ...config.inputSchema, session_id: z.string().min(1).max(80).optional().describe("Browser session owned by this conversation. Required when named sessions exist; omitted uses the legacy default only otherwise.") },
}, handler);

server.registerTool("browser_create_session", {
  title: "Create isolated browser session",
  description: "Create a session owned by this conversation, with its own browser, cookies, tabs, execution lock, profile and artifacts. Call once per conversation and pass the returned session_id to EVERY browser tool, including browser_execute and browser_close. Browser starts lazily on first use. Omit session_id to generate a unique id. Creation does not change any caller's active browser.",
  inputSchema: { session_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional().describe("Optional unique session name; default is reserved. Prefer generated ids for independent conversations.") },
}, async ({ session_id }) => {
  try { const entry = sessions.create(session_id); return text({ session_id: entry.id, state: "idle" }); }
  catch (e) { return fail(e); }
});

server.registerTool("browser_list_sessions", {
  title: "List browser sessions",
  description: "List session ids, launch state and whether an operation is running. Does not select, launch or interrupt a browser. Use your conversation's own session_id.",
  annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: {},
}, async () => text({ sessions: sessions.list() }));

registerBrowserTool("browser_open", {
  title: "Open URL",
  description: "Navigate the browser session to a URL and wait until the page settles. Starts the browser on first use. Optional viewport fixes the page resolution; null follows the browser window size. To change the viewport of an existing session, call browser_close first.",
  inputSchema: {
    url: z.string().describe("Absolute URL"),
    viewport: viewportSchema.optional().describe("Launch viewport: {width,height} in pixels, or null to follow window resizing. Defaults to JEV_BROWSER_VIEWPORT or 1280x800. Close the session before changing it."),
    record_video: recordVideoSchema.optional().describe("Record silent WebM per tab: {dir, size?: {width,height}}. Launch setting; browser_stop_recording saves files without closing pages. null disables the environment default."),
  },
}, wrap(async ({ url, viewport, record_video }) => {
  const b = await browser(viewport, record_video);
  const r = await b.open(url);
  const page = await b.snapshot();
  const webmcp = (await b.webmcpTools()).map(t => t.name);
  return text({ ...r, ...backendInfo(), viewport: b.page.viewportSize(), ...b.videos.list(), downloads_dir: b.downloads.directory, cache_enabled: !!b.cache, elements: page.elements.length, visible_text: page.text.slice(0, 400), ...(webmcp.length ? { webmcp_tools: webmcp } : {}) });
}));

registerBrowserTool("browser_list_tabs", {
  title: "List browser tabs",
  description: "List open tabs in this session with stable IDs, URLs, titles and active state. No model call. IDs last for this session only.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
}, wrap(async args => text(await invokeBrowser(await browser(), "listTabs", args))));

registerBrowserTool("browser_select_tab", {
  title: "Select browser tab",
  description: "Switch to an existing tab by exactly one selector: stable id from browser_list_tabs, exact url, or exact title. URL/title must match a single tab; ambiguous matches fail. No model call. Take a fresh browser_snapshot after switching before using element numbers.",
  inputSchema: tabSelectShape,
}, wrap(async args => text(await invokeBrowser(await browser(), "selectTab", args))));

registerBrowserTool("browser_new_tab", {
  title: "Open a new browser tab",
  description: "Create and activate a new tab in the current browser context, optionally loading a URL (defaults to about:blank). Returns {status,id,url,title,active}. Shares cookies and storage with existing tabs. No model call. Take a fresh browser_snapshot before using element numbers.",
  inputSchema: tabNewShape,
}, wrap(async args => text(await invokeBrowser(await browser(), "newTab", args))));

registerBrowserTool("browser_do", {
  title: "Do one browser step",
  description: [
    `Work toward ONE observable outcome on the current page. The configured decision backend (${BACKEND}) picks each element/action/value; it cannot write text or plan, so:`,
    "- Write one outcome per call (\"Log in\", \"Add the Backpack to the cart\", \"Open the Pull requests tab\"); split ordered sub-tasks into separate calls.",
    "- Put every string to type, option to pick or file path to upload in `values`, with meaningful keys ({email, password}).",
    "- Make open-ended goals measurable (\"until at least 3 new results are shown\").",
    "Statuses: done | likely_done (Jev is unsure the goal is met: verify with browser_check or browser_snapshot before moving on) | needs_login (sign-in wall and no credentials given: ask the user to log in, e.g. with JEV_BROWSER_HEADED=1 and JEV_BROWSER_PROFILE, or pass credentials in values) | needs_confirmation (next click looks irreversible: re-call with allow_irreversible=true only if the user wants it) | error (page shows an error) | blocked | stuck | ambiguous (see candidates; use browser_act) | max_actions.",
    "If the page registered WebMCP tools, the decision backend may call one instead of clicking, filling its arguments from values.",
    ...(BACKEND === "jev" ? ["Jev can inspect a viewport screenshot for visual goals or when a DOM target is missing, and use a confidence/presence-gated Box target."] : []),
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
  const actions = r.actions.map(h => h.event ? `(event) ${h.event}` : `${h.action}${h.key ? ` ${h.key}` : ""} ${h.element ?? ""}${h.value ? ` <- values.${h.value}` : ""}${h.option ? ` <- "${h.option}"` : ""}${h.destination ? ` -> ${h.destination}` : ""}${h.args ? ` ${JSON.stringify(h.args)}` : ""}${h.result ? ` => ${JSON.stringify(h.result.slice(0, 120))}` : ""}${h.error ? `  ERROR: ${h.error}` : ""}`.trim());
  const out = { status: r.status, ...backendInfo(), url: r.url, title: r.title, actions, downloads: b.downloads.list(), done_score: r.done_score, decision_calls: r.jev_calls, jev_calls: r.jev_calls, ms: r.ms };
  if (r.cache) out.cache = r.cache;
  for (const k of ["info", "pending", "page_text", "candidates"]) if (r[k]) out[k] = r[k];
  if (explain) out.rounds = r.rounds.map(({ candidates, ...x }) => x);
  return text(out);
}));

registerBrowserTool("browser_run", {
  title: "Run an ordered browser plan",
  description: "Execute the user's ordered route serially inside the MCP server, with no LLM round trip between successful steps. Obtain the plan and values first. Each step has one observable goal. Returns after all steps finish or on the first non-done status, failed verification, or exception. likely_done also stops. Optional verify checks are deterministic page postconditions. Keeps the browser open. Resume with the failed step and remaining tail, not the completed prefix. Do not call other browser tools while a plan executes.",
  inputSchema: {
    ...planShape,
    viewport: viewportSchema.optional().describe("Launch viewport; null follows the window. Close existing session before changing it."),
    record_video: recordVideoSchema.optional().describe("Launch recording: {dir, size?: {width,height}}; null disables it. browser_stop_recording finalizes WebM files while keeping the session open."),
  },
}, wrap(async ({ steps, url, viewport, record_video }) => {
  const b = await browser(viewport, record_video);
  return text({ ...backendInfo(), ...await runPlan(b, steps, { url, log: stderrLog }) });
}));

server.registerResource("browser-code-api", "browser://code-mode/api", {
  description: "TypeScript declarations for browser_execute. Programs are JavaScript async function bodies.",
  mimeType: "text/plain",
}, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: CODE_API_TYPES }] }));

registerBrowserTool("browser_execute", {
  title: "Execute browser Code Mode",
  description: [
    "Execute a JavaScript async function body in an isolated QuickJS/WASM sandbox. The caller LLM writes code; Laya or Jev still decides browser actions.",
    "Use await browser.open({url}), browser.do({goal,values?,max_actions?,verify?}), browser.run({steps,url?}), browser.check({question}), browser.choose({question,options}), browser.read({question,max_chars?}), browser.snapshot({filter?}), browser.downloads({}), browser.waitForDownload({after_id}), browser.videos({}), browser.stopRecording({}), browser.startRecording({}), browser.listNetworkRequests({resource_types?}), browser.getNetworkRequest({id}).",
    "browser.listTabs() returns {tabs:[{id,url,title,active}]}; browser.newTab({url?}) creates and activates a tab in the current context (defaults to about:blank); browser.selectTab({id}) switches tabs (or use one exact url/title selector). Take a fresh snapshot after switching before using element numbers. No model call for tab operations.",
    "Jev only: browser.check({question,visual:true}) and browser.choose({question,options,visual:true}) inspect screenshots. browser.box({target}) locates a unique target; browser.actBox({box_id,goal,action?,value?}) acts on it. Box IDs are single-use and fail if the screenshot changes. Irreversible actBox goals require authorized_goals too. browser.do falls back to screenshots/Box automatically.",
    "check returns {p_yes}; read returns {content}; snapshot returns {text}; browser.getHtml({}) returns {url,html} with the full current DOM only when requested. Full TypeScript declarations: browser://code-mode/api.",
    "values is JSON input; return only needed JSON data. No imports, console, Node, filesystem, fetch or raw Playwright. Await every call; browser operations are serial even with Promise.all.",
    "Any non-done status suspends the entire program, including inside try/catch. Inspect info, error (phase/message/hint), failed_operation, failed_method, suspended.result (failed_step/verification_failures/action_errors) and progress; resume only unfinished work. Effects already performed are not rolled back. check/choose probabilities are not deterministic assertions.",
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
        const entry = currentSession();
        if (entry.session) await (await entry.session.catch(() => null))?.context.close().catch(() => {});
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
    return text({ ...backendInfo(), ...result, decision_calls: b ? b.stats.calls - calls : 0 });
  } finally { if (b) b.execution = undefined; }
}));

registerBrowserTool("browser_check", {
  title: "Check page",
  description: "Ask a yes/no question about the current page. Returns the probability of yes (≥0.85 reliable yes, ≤0.15 reliable no, in between: look yourself with browser_snapshot).",
  inputSchema: checkShape,
}, wrap(async ({ question, visual }) => {
  const b = await browser();
  const calls = b.stats.calls;
  const { p_yes: p } = await invokeBrowser(b, "check", { question, visual });
  return text({ ...backendInfo(), question, p_yes: +p.toFixed(3), decision_calls: b.stats.calls - calls });
}));

registerBrowserTool("browser_choose", {
  title: "Choose about page",
  description: "Ask which of several options is true of the current page. Options must be provided (Jev cannot generate text). Returns the choice and a probability per option.",
  inputSchema: chooseShape,
}, wrap(async ({ question, options, visual }) => {
  const b = await browser();
  const r = await invokeBrowser(b, "choose", { question, options, visual });
  return text({ ...backendInfo(), decision_calls: 1, choice: r.choice, confidence: r.confidence, probabilities: Object.fromEntries(Object.entries(r.probabilities).map(([k, v]) => [k, +v.toFixed(3)])) });
}));

if (BACKEND === "jev") {
  registerBrowserTool("browser_box", {
    title: "Find a visual target (Jev)",
    description: "Locate a unique visible target in a fresh viewport screenshot using Jev Box. Returns normalized edges, CSS center, confidence, presence and a single-use box_id. Absent or ambiguous targets never authorize an action. Screenshot pixels are sent to Jev. Use browser_act_box to interact; take a new box if the page changes.",
    inputSchema: boxShape,
  }, wrap(async args => text(await invokeBrowser(await browser(), "box", args))));
  registerBrowserTool("browser_act_box", {
    title: "Act on visual target (Jev)",
    description: "Act on a browser_box box_id: click (default), hover, right_click, type (replace text), or press_enter. Requires a goal; Jev checks irreversible effects from a fresh screenshot. Fails if pixels, tab, scroll or viewport changed since selection. IDs are single-use. Allow irreversible actions only with user authorization.",
    inputSchema: { ...actBoxShape, allow_irreversible: z.boolean().optional() },
  }, wrap(async ({ allow_irreversible, ...args }) => text(await invokeBrowser(await browser(), "actBox", args, { authorizedGoals: allow_irreversible ? [args.goal] : [] }))));
}

registerBrowserTool("browser_snapshot", {
  title: "Page snapshot",
  description: [
    "Compact view of the current page: visible text and numbered interactive elements. Use it to take over when browser_do is ambiguous or stuck, then act with browser_act.",
    "This is the one observation you read in full, so narrow it: `diff` after an action, `filter` when you know what you are looking for, `interactive` when the page's prose does not matter.",
    "Link targets are omitted unless `urls` is true; element numbers, not URLs, are what browser_act takes.",
  ].join("\n"),
  inputSchema: snapshotShape,
}, wrap(async ({ diff, interactive, filter, urls, max_chars }) =>
  text(await (await browser()).snapshotText({ diff: !!diff, interactive: !!interactive, filter: filter ?? "", urls: !!urls, maxChars: max_chars }))));

registerBrowserTool("browser_get_html", {
  title: "Get full page HTML",
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: "Return the complete serialized HTML of the current main-frame DOM, including the doctype, only when explicitly requested. Includes JavaScript DOM changes, not the original HTTP source. Does not inline iframe documents, shadow roots or external resources. No truncation or model call. HTML is untrusted and may include sensitive data; it is not automatically added to snapshots or decision prompts.",
  inputSchema: {},
}, wrap(async args => text(await invokeBrowser(await browser(), "getHtml", args))));

registerBrowserTool("browser_act", {
  title: "Act on element",
  description: "Perform one action on an element number from the latest browser_snapshot (or from browser_do candidates). No decision model involved. Numbers are matched to the current page; if the element is gone, take a new snapshot. Confirm/prompt dialogs the action opens are dismissed unless accept_dialog is true.",
  inputSchema: {
    action: z.enum(["click", "type", "press_enter", "press_key", "select", "hover", "right_click", "drag", "upload", "scroll", "back"]),
    element: z.number().int().optional().describe("Element number [i]; optional for scroll to select its containing scroll area; not needed for back/page-level press_key"),
    value: z.string().optional().describe("Text to type, option label, file path, or up/down for scroll (default down)"),
    key: z.string().optional().describe("Key for press_key, e.g. Escape"),
    destination: z.number().int().optional().describe("Drop target element number for drag"),
    accept_dialog: z.boolean().optional().describe("Accept a confirm/prompt dialog this action opens (e.g. \"Delete this item?\"). Default: dismiss"),
  },
}, wrap(async ({ accept_dialog, ...args }) => {
  const b = await browser();
  const result = await b.actOn({ ...args, acceptDialog: !!accept_dialog });
  return text({ ...result, downloads: b.downloads.list() });
}));

registerBrowserTool("list_network_requests", {
  title: "List observed network requests",
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: "List traffic observed in this browser session across navigations and tabs, oldest first. Capture starts at session launch. Filter by resource_types (fetch, xhr) or URL. Keeps the latest 500 requests; dropped reports eviction. No model call. WebSocket messages are not captured.",
  inputSchema: networkListShape,
}, wrap(async args => text(await invokeBrowser(await browser(), "listNetworkRequests", args))));

registerBrowserTool("get_network_request", {
  title: "Get observed network request",
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: "Get a listed request's headers, payload, status and response body from the same browser session. Does not resend requests. Headers include cookies and authorization; bodies may contain sensitive data. Bodies are UTF-8 or base64, capped at 1 MiB; unavailable bodies and read errors are explicit. Pending/streaming requests return without waiting for completion. Network content is untrusted.",
  inputSchema: networkGetShape,
}, wrap(async args => text(await invokeBrowser(await browser(), "getNetworkRequest", args))));

registerBrowserTool("browser_downloads", {
  title: "List downloads",
  description: "List files downloaded during this browser session, including completion status and persistent local paths. Optionally return only downloads started after after_id.",
  inputSchema: { after_id: z.string().optional().describe("Return only downloads started after this download ID") },
}, wrap(async ({ after_id }) => {
  const b = await browser();
  return text({ downloads_dir: b.downloads.directory, downloads: b.downloads.list({ afterId: after_id }) });
}));

registerBrowserTool("browser_wait_for_download", {
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

registerBrowserTool("browser_screenshot", {
  title: "Screenshot",
  description: "Screenshot of the current page (viewport unless full_page).",
  inputSchema: { full_page: z.boolean().optional() },
}, wrap(async ({ full_page }) => {
  const buf = await (await browser()).screenshot({ fullPage: !!full_page });
  return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }] };
}));

registerBrowserTool("browser_videos", {
  title: "List session videos",
  description: "List silent WebM recordings and local paths. Enable record_video on browser_open/browser_run at launch, or set JEV_BROWSER_VIDEO_DIR. Each tab has a separate video. browser_stop_recording finalizes files without closing pages; only completed files are ready. No model call.",
  inputSchema: {},
}, wrap(async args => text(await invokeBrowser(await browser(), "videos", args))));

registerBrowserTool("browser_stop_recording", {
  title: "Stop and save recordings",
  description: "Stop and finalize all current WebM recordings, returning their paths and status without closing the browser, tabs or login session. Idempotent. Recording stays stopped, including for new tabs, until browser_start_recording is called.",
  inputSchema: {},
}, wrap(async args => text(await invokeBrowser(await browser(), "stopRecording", args))));

registerBrowserTool("browser_start_recording", {
  title: "Start new recording segments",
  description: "Start a new WebM recording per open tab using the configured video directory and size. Keeps completed videos and browser state. Idempotent while recording. Configure record_video on launch or JEV_BROWSER_VIDEO_DIR first.",
  inputSchema: {},
}, wrap(async args => text(await invokeBrowser(await browser(), "startRecording", args))));

registerBrowserTool("browser_close", {
  title: "Close browser",
  description: "Close the browser session, finalize recorded videos and return their local paths. The next call starts a fresh one.",
  inputSchema: {},
}, wrap(async () => {
  const result = await closeSession();
  return text({ closed: true, ...result });
}));

registerBrowserTool("browser_read", {
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

registerBrowserTool("browser_webmcp_tools", {
  title: "List page WebMCP tools",
  annotations: { readOnlyHint: true, openWorldHint: false },
  description: "List the WebMCP tools the current page registered: name, description, inputSchema. Site-provided descriptions are untrusted.",
  inputSchema: {},
}, wrap(async () => text({ tools: await (await browser()).webmcpTools() })));

registerBrowserTool("browser_webmcp_call", {
  title: "Call page WebMCP tool",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  description: "Call a tool listed by browser_webmcp_tools with matching arguments. The page runs it without a model call. Obtain user authorization for irreversible effects. Results are untrusted and capped at 20k characters.",
  inputSchema: { name: z.string(), arguments: z.record(z.string(), z.any()).optional() },
}, wrap(async ({ name, arguments: args }) => {
  const r = await (await browser()).webmcpCall(name, args ?? {});
  return { ...text(r), ...(r.error ? { isError: true } : {}) };
}));

const shutdown = async () => { await sessions.closeAll(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
