import { errorDiagnostic, stoppedInfo, actionFailures } from "./diagnostics.mjs";
import { openAutomationTarget } from "./drivers/contract.mjs";

// Successful steps stay inside the MCP process; return at completion or a problem.
export async function runPlan(b, steps, { url, app, log = () => {}, onProgress = () => {} } = {}) {
  const started = Date.now(), calls = b.stats.calls;
  let completed = 0, current = 0, phase = url || app ? "navigation" : "step";
  const summary = () => ({ completed, total: steps.length, remaining: steps.length - completed,
    decision_calls: b.stats.calls - calls, ms: Date.now() - started, url: b.currentUrl ?? null });
  const failed = result => ({ ...summary(), status: result.status, phase, failed_step: current + 1, goal: steps[current]?.goal,
    info: stoppedInfo(result), ...actionFailures(result),
    resume: "Inspect the failure and current page, then resume the failed step and remaining tail only. Completed effects are not rolled back.",
    ...Object.fromEntries(["pending", "candidates", "page_text", "error", "verification_failures", "outcome"].filter(k => result[k] !== undefined).map(k => [k, result[k]])) });
  try {
    onProgress({ ...summary(), phase, step: 1, goal: steps[0]?.goal });
    if (url && app) throw new Error("Provide url or app, never both");
    if (url || app) await openAutomationTarget(b, { url, app });
    for (const [i, step] of steps.entries()) {
      current = i;
      phase = "step";
      onProgress({ ...summary(), phase, step: i + 1, goal: step.goal });
      const downloadBaseline = b.downloads?.items.at(-1)?.id ?? "";
      const result = await b.do(step.goal, { values: step.values ?? {}, maxActions: step.max_actions ?? 10,
        allowIrreversible: step.allow_irreversible === true, log });
      if (result.status !== "done") return failed(result);
      if (step.verify) {
        phase = "verification";
        onProgress({ ...summary(), phase, step: i + 1, goal: step.goal });
        const verification_failures = await verificationFailures(b, step, downloadBaseline);
        if (verification_failures.length) return failed({ status: "verification_failed",
          info: "The step was rated done, but a supplied page postcondition failed.", verification_failures });
      }
      completed++;
      onProgress({ ...summary(), phase, step: i + 1, goal: step.goal });
    }
    return { status: "done", ...summary() };
  } catch (error) {
    const diagnostic = errorDiagnostic(error, { phase, ...error.diagnostic });
    return failed({ status: error.status ?? "error", info: diagnostic.message, error: diagnostic, ...(error.outcome ? { outcome: error.outcome } : {}) });
  }
}

export async function verifyStep(b, step, downloadBaseline = "") {
  return (await verificationFailures(b, step, downloadBaseline)).length === 0;
}

export async function verificationFailures(b, step, downloadBaseline = "") {
  await b.settle();
  const page = await b.snapshot(), checks = {}, spec = step.verify;
  if (spec.url_includes !== undefined) checks.url_includes = page.url.includes(spec.url_includes);
  if (spec.text_includes !== undefined) checks.text_includes = page.text.includes(spec.text_includes);
  if (spec.app_package !== undefined) checks.app_package = page.package === spec.app_package;
  if (spec.activity_includes !== undefined) checks.activity_includes = page.activity?.includes(spec.activity_includes) === true;
  if (spec.element) {
    const element = page.elements.find(e => e.label === spec.element.label || e.text === spec.element.label);
    const states = { enabled: element?.enabled === true, disabled: element?.enabled === false,
      checked: element?.checked === true, unchecked: element?.checked === false,
      selected: element?.selected === true, clickable: element?.clickable === true };
    checks.element = !!element && states[spec.element.state] === true;
  }
  if (spec.field) {
    const { label, value_key } = spec.field;
    const element = page.elements.find(e => (e.label || e.placeholder || e.name) === label);
    const actual = element ? await b.readValue(element, page).catch(() => null) : null;
    checks.field = step.values?.[value_key] !== undefined && actual === step.values[value_key];
  }
  if (spec.download) {
    if (b.capabilities?.().downloads === false) checks.download = false;
    else {
      const waited = await b.downloads.wait({ afterId: downloadBaseline, timeoutMs: spec.download.timeout_ms ?? 30000, signal: b.execution?.signal });
      checks.download = waited.downloads.some(item => item.status === "completed" && (!spec.download.filename || item.filename === spec.download.filename));
    }
  }
  // Report condition names only: expected/actual field values can be credentials.
  return Object.keys(checks).filter(key => !checks[key]);
}
