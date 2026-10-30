import { Worker } from "node:worker_threads";
import { z } from "zod";
import { codeSchemas } from "./browser-api.mjs";
import { errorDiagnostic, stoppedInfo } from "./diagnostics.mjs";

export const executeShape = {
  code: z.string().min(1).max(50000).describe("JavaScript async function body. Use browser methods, values, await and return. No imports or Node APIs. See browser://code-mode/api."),
  values: z.record(z.string(), z.unknown()).optional().describe("JSON data available to the program; do not embed credentials in source"),
  timeout_ms: z.number().int().min(100).max(300000).optional().describe("Wall time including browser calls; default 120000. Timeout closes the browser session."),
  max_operations: z.number().int().min(1).max(100).optional().describe("Browser API calls; default 30. run() also obeys the decision budget."),
  max_decision_calls: z.number().int().min(1).max(300).optional().describe("Shared Laya/Jev inference budget; default 100"),
  max_browser_actions: z.number().int().min(1).max(1000).optional().describe("Total low-level actions, including cache replay and nested run steps; default 100"),
  max_output_chars: z.number().int().min(100).max(200000).optional().describe("Final JSON result budget; default 20000"),
  authorized_goals: z.array(z.string().min(1)).max(30).optional().describe("Exact goals the user authorized for irreversible effects. Set only from user authorization, outside the program."),
};
export const executeSchema = z.object(executeShape).strict();

export class ExecutionStop extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A lease covers an entire MCP operation, not just a plan. Concurrent requests fail
// explicitly instead of interleaving snapshots, actions and dialog policies.
export class BrowserLease {
  busy = false;
  async run(fn) {
    if (this.busy) throw new Error("A browser operation is executing. Wait for it to finish before calling another browser tool.");
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
}

export async function executeCode(input, { invoke, onAbort = async () => {}, signal } = {}) {
  const args = executeSchema.parse(input), started = Date.now();
  const values = JSON.parse(JSON.stringify(args.values ?? {}));
  if (JSON.stringify(values).length > 128000) throw new Error("values exceeds 128000 characters");
  const controller = new AbortController();
  const timeoutMs = args.timeout_ms ?? 120000;
  const progress = [];
  let operations = 0, stopped = false, active = false, abortActive = false, queue = Promise.resolve(), worker, timer;
  let complete;
  const outcome = new Promise(resolve => { complete = resolve; });
  const stop = result => {
    if (stopped) return;
    stopped = true;
    if (result.status !== "done") {
      const record = progress.at(-1);
      if (record && (!record.status || record.status !== "done")) {
        record.status = result.status;
        record.info = result.info ?? result.suspended?.result?.info;
        result.failed_operation ??= record.operation;
        result.failed_method ??= record.method;
      }
      result.resume ??= "Inspect progress and the failure details; resume only unfinished operations. Completed effects are not rolled back.";
    }
    abortActive = active;
    // Abort is sticky and owned by the supervisor: guest try/catch cannot resume it.
    controller.abort(new ExecutionStop(result.status, result.info ?? result.status));
    complete(result);
  };
  const abort = () => stop({ status: "cancelled", info: "Execution cancelled" });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    worker = new Worker(new URL("./code-worker.mjs", import.meta.url), { workerData: {
      code: args.code, values, methods: Object.keys(codeSchemas), timeoutMs,
      maxOperations: args.max_operations ?? 30, maxOutputChars: args.max_output_chars ?? 20000,
      memoryBytes: 32 * 1024 * 1024,
    } });
    timer = setTimeout(() => stop({ status: "timeout", info: `Execution exceeded timeout_ms (${timeoutMs} ms)${active ? ` while browser.${progress.at(-1)?.method} was active. The session is closed to stop pending browser work` : " during sandbox execution"}.` }), timeoutMs);
    worker.on("error", error => { const diagnostic = errorDiagnostic(error, { phase: "sandbox" }); stop({ status: "error", info: diagnostic.message, error: diagnostic }); });
    worker.on("exit", code => { if (!stopped) stop({ status: "error", info: `Sandbox exited without a result (${code})` }); });
    worker.on("message", message => {
      if (stopped) return;
      if (message.type === "result") {
        if (message.json.length > (args.max_output_chars ?? 20000)) return stop({ status: "limit_exceeded", info: "Output budget exhausted" });
        try { return stop({ status: "done", result: JSON.parse(message.json) }); }
        catch { return stop({ status: "error", info: "Program must return JSON-serializable data" }); }
      }
      if (message.type === "error" || message.type === "limit") {
        return stop({ status: message.type === "limit" ? "limit_exceeded" : "error", info: message.info });
      }
      if (message.type !== "call") return;
      if (++operations > (args.max_operations ?? 30)) return stop({ status: "limit_exceeded", info: "Browser operation budget exhausted" });
      queue = queue.then(async () => {
        if (stopped) return;
        const record = { operation: message.id, method: message.method };
        progress.push(record);
        try {
          if (!Object.hasOwn(codeSchemas, message.method)) throw new Error("Unknown browser method");
          const parsed = codeSchemas[message.method].parse(JSON.parse(message.json));
          if (parsed.goal) record.goal = parsed.goal;
          active = true;
          let result;
          try {
            result = await invoke(message.method, parsed, { signal: controller.signal,
              authorizedGoals: args.authorized_goals ?? [], maxDecisionCalls: args.max_decision_calls ?? 100,
              maxBrowserActions: args.max_browser_actions ?? 100,
              onProgress: detail => { if (!stopped) record.plan = detail; } });
          } finally { active = false; }
          if (stopped) return;
          record.status = result?.status ?? "done";
          if (result?.status && result.status !== "done" && result.status !== "completed") {
            const info = stoppedInfo(result);
            record.info = info;
            return stop({ status: result.status, info, ...(result.outcome ? { outcome: result.outcome } : {}), suspended: { operation: message.id, method: message.method, result } });
          }
          const json = JSON.stringify(result ?? null);
          if (json.length > 1000000) throw new ExecutionStop("limit_exceeded", "Intermediate result exceeds 1000000 characters");
          worker.postMessage({ id: message.id, json });
        } catch (error) {
          if (stopped) return;
          record.status = error.status ?? "error";
          if (error.outcome) record.outcome = error.outcome;
          const diagnostic = errorDiagnostic(error, { phase: "operation", ...error.diagnostic, method: message.method });
          record.info = diagnostic.message;
          stop({ status: record.status, info: diagnostic.message, error: diagnostic, ...(error.outcome ? { outcome: error.outcome } : {}), failed_operation: message.id, failed_method: message.method });
        }
      }).catch(error => stop({ status: "error", info: String(error.message).slice(0, 500) }));
    });
    if (signal?.aborted) abort();
    const result = await outcome;
    clearTimeout(timer);
    await worker.terminate();
    // Cancelling an active Playwright operation requires closing its context. Keep the
    // session lease until the operation has drained, so it cannot affect the next run.
    if (abortActive) {
      try { await onAbort(); result.session_closed = true; }
      catch (error) { result.cleanup_error = errorDiagnostic(error, { phase: "cleanup" }); }
    }
    await queue;
    return { ...result, operations: progress.length, progress, ms: Date.now() - started };
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await worker?.terminate();
  }
}
