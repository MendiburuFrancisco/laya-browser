// Keep driver call logs and nested network causes, but bound MCP output. Do not
// include request arguments, credentials, source code or stacks in diagnostics.
export function errorDiagnostic(error, context = {}) {
  const messages = [], seen = new Set();
  for (let e = error; e != null && !seen.has(e) && messages.length < 5; e = e.cause) {
    seen.add(e);
    messages.push(`${e.code ? `${e.code}: ` : ""}${String(e.message ?? e)}`);
  }
  const message = messages.join("\nCaused by: ");
  const limit = 6000;
  const diagnostic = { ...context, name: error?.name ?? "Error", message: message.length > limit ? `${message.slice(0, limit)}\n[error details truncated]` : message };
  if (error?.code) diagnostic.code = String(error.code);
  if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory.*in use/i.test(message)) {
    diagnostic.hint = "The browser profile is already in use. Close the process using JEV_BROWSER_PROFILE or configure a separate profile, then retry.";
  } else if (/Executable doesn't exist|not installed|was not found/i.test(message)) {
    diagnostic.hint = "Check JEV_BROWSER. Install the selected browser, or run npx playwright install chromium for Playwright Chromium.";
  } else if (/Target.*closed|browser.*closed|context.*closed|disconnected/i.test(message)) {
    diagnostic.hint = "The browser, context or tab was closed. Inspect open tabs if available; otherwise call browser_close and browser_open, then resume only unfinished work.";
  } else if (/ECONNREFUSED|ENOTFOUND|fetch failed|net::ERR_/i.test(message)) {
    diagnostic.hint = "Check the reported host, service and network connection. For model requests, check JEV_API_URL and that the decision backend is running.";
  } else if (/timeout|timed out/i.test(message)) {
    diagnostic.hint = "Inspect the active operation and page state before retrying. Increase the relevant timeout only if the operation is expected to take longer.";
  }
  return diagnostic;
}

export function stoppedInfo(result) {
  return result.info || ({
    blocked: "The observed page blocks progress (for example access denied, a CAPTCHA or an error page). Inspect page_text before retrying.",
    stuck: "No action could make progress toward the goal. Inspect the page and any action errors before retrying.",
    max_actions: "The step exhausted max_actions before the goal was confirmed. Inspect the page and last action error; resume only unfinished work.",
    likely_done: "The goal may be complete, but the decision backend is uncertain. Verify the current page before continuing.",
    needs_login: "Sign-in is required before this step can continue.",
    needs_confirmation: "The next action requires explicit authorization for this exact goal.",
    ambiguous: "The next target is ambiguous. Inspect candidates or refine the goal.",
  }[result.status] ?? `Browser operation stopped with status ${result.status}. Inspect the returned details before retrying.`);
}

export function actionFailures(result) {
  const errors = (result.actions ?? []).filter(action => action.error).slice(-3)
    .map(({ action, element, error }) => ({ action, element, error }));
  return errors.length ? { action_errors: errors } : {};
}
