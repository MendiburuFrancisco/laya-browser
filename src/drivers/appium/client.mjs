import { randomUUID } from "node:crypto";

export class AppiumError extends Error {
  constructor(message, { status, method, path, outcome = "known", code = "appium_error", phase, transportPhase, attemptId, durationMs } = {}) {
    super(message);
    this.name = "AppiumError";
    this.httpStatus = status;
    this.code = code;
    this.method = method;
    this.path = path;
    this.outcome = outcome;
    this.diagnostic = {
      phase: phase ?? mutationPhase(method), outcome,
      ...(transportPhase ? { transport_phase: transportPhase } : {}),
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      ...(status !== undefined ? { http_status: status } : {}),
    };
  }
}

const mutationPhase = method => ["POST", "DELETE"].includes(method) ? "mobile_action" : "mobile_observation";
const SAFE_CAPABILITIES = ["platformName", "appium:automationName", "appium:udid", "appium:appPackage", "appium:appActivity", "appium:appWaitActivity", "appium:newCommandTimeout", "appium:noReset", "appium:forceAppLaunch"];
const safeCapabilities = capabilities => Object.fromEntries(SAFE_CAPABILITIES.filter(key => capabilities?.[key] !== undefined).map(key => [key, capabilities[key]]));
const connectionFailure = error => error?.name !== "SyntaxError" && (/^(UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|ENETUNREACH|ETIMEDOUT)$/.test(error?.code) || /fetch failed|terminated|socket|network error|connection (?:closed|lost|reset)/i.test(error?.message ?? ""));

export class AppiumClient {
  constructor({ url = process.env.APPIUM_URL ?? "http://127.0.0.1:4723", fetchImpl = fetch, timeoutMs = 15000, createTimeoutMs = 90000, logger = () => {} } = {}) {
    this.baseUrl = new URL(url);
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) throw new TypeError("Appium URL must be HTTP(S) without credentials, query or fragment");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.createTimeoutMs = createTimeoutMs;
    this.logger = logger;
    this.sessionId = null;
  }

  trace(event, { attemptId, operation, transportPhase, started, ...detail } = {}) {
    const record = {
      event,
      ...(attemptId ? { attempt_id: attemptId } : {}),
      ...(operation ? { operation } : {}),
      ...(transportPhase ? { transport_phase: transportPhase } : {}),
      ...(started !== undefined ? { duration_ms: Date.now() - started } : {}),
      ...detail,
    };
    try { this.logger(record); } catch {}
  }

  async request(method, path, body, { mutation = false, timeoutMs = this.timeoutMs, signal = this.getSignal?.(), attemptId = randomUUID(), operation = mutationPhase(method) } = {}) {
    const started = Date.now();
    let response, payload, transportPhase = "http_headers";
    const fail = (code, message, outcome) => {
      this.trace("http_error", { attemptId, operation, transportPhase, started, code, outcome, http_status: response?.status });
      return new AppiumError(message, { status: response?.status, method, path, outcome, code, phase: operation, transportPhase, attemptId, durationMs: Date.now() - started });
    };
    if (signal?.aborted) {
      transportPhase = "preflight";
      throw fail("appium_aborted", `Appium ${method} aborted before the request was sent`, "known");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    this.trace("http_request", { attemptId, operation, transportPhase, started, method, path });
    try {
      response = await this.fetch(new URL(path.replace(/^\//, ""), this.baseUrl.href.endsWith("/") ? this.baseUrl : `${this.baseUrl.href}/`), {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      this.trace("http_headers", { attemptId, operation, transportPhase, started, http_status: response.status });
      transportPhase = "http_body";
      payload = await response.json();
      this.trace("http_body", { attemptId, operation, transportPhase, started, http_status: response.status });
    } catch (cause) {
      const disconnected = connectionFailure(cause);
      const code = signal?.aborted ? "appium_aborted" : timedOut ? "appium_timeout" : response && !disconnected ? "appium_invalid_response" : "appium_connection_error";
      const detail = signal?.aborted ? "aborted by the caller" : timedOut ? `timed out after ${timeoutMs} ms` : response && !disconnected ? "returned an invalid response body" : "connection failed";
      throw fail(code, `Appium ${method} ${detail} during ${transportPhase}`, mutation ? "unknown" : "known");
    } finally { clearTimeout(timer); }
    if (!response.ok || payload?.value?.error) {
      const expired = payload?.value?.error === "invalid session id";
      const code = expired ? "appium_session_expired" : "appium_http_error";
      const message = expired ? "Appium session is expired or no longer available" : `Appium ${method}: ${payload?.value?.error ?? `HTTP ${response.status}`}`;
      this.trace("http_error", { attemptId, operation, transportPhase, started, code, outcome: "known", http_status: response.status });
      throw new AppiumError(message, { status: response.status, method, path, code, phase: operation, transportPhase, attemptId, durationMs: Date.now() - started });
    }
    return payload?.value ?? payload;
  }

  async createSession(capabilities) {
    if (this.sessionId) throw new AppiumError("Appium session already exists", { phase: "session_create" });
    if (this.creating) throw new AppiumError("Appium session creation is already in progress", { phase: "session_create" });
    if (this.creationUnknown) throw new AppiumError("Previous session creation outcome is unknown; resolve it on the Appium server before creating another session", { outcome: "unknown", phase: "session_create", attemptId: this.lastAttemptId });
    const attemptId = randomUUID(), started = Date.now();
    this.lastAttemptId = attemptId;
    let result;
    this.creating = true;
    this.trace("session_create", { attemptId, operation: "session_create", started, state: "started", capabilities: safeCapabilities(capabilities) });
    try {
      result = await this.request("POST", "/session", { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, { mutation: true, timeoutMs: this.createTimeoutMs, attemptId, operation: "session_create" });
    } catch (error) {
      if (error.outcome === "unknown") this.creationUnknown = true;
      this.trace("session_create", { attemptId, operation: "session_create", started, state: "failed", code: error.code, outcome: error.outcome });
      throw error;
    } finally { this.creating = false; }
    const id = result?.sessionId ?? result?.session_id;
    if (!id) {
      this.creationUnknown = true;
      this.trace("session_create", { attemptId, operation: "session_create", started, state: "failed", code: "appium_session_id_missing", outcome: "unknown" });
      throw new AppiumError("Appium created a session without returning its session id", { method: "POST", path: "/session", outcome: "unknown", code: "appium_session_id_missing", phase: "session_id_extract", attemptId, durationMs: Date.now() - started });
    }
    this.sessionId = id;
    this.trace("session_create", { attemptId, operation: "session_create", started, state: "confirmed", session_id: id });
    return result;
  }

  async command(method, path, body, options) {
    if (!this.sessionId) throw new AppiumError("Appium session is not open");
    return this.request(method, `/session/${encodeURIComponent(this.sessionId)}/${path.replace(/^\//, "")}`, body, options);
  }

  async findElement(xpath) {
    const value = await this.command("POST", "element", { using: "xpath", value: xpath });
    const id = value?.["element-6066-11e4-a52e-4f735466cecf"] ?? value?.ELEMENT;
    if (!id) throw new AppiumError("Appium did not return an element id", { method: "POST", path: "element" });
    return id;
  }

  async elementCommand(id, method, path, body) {
    return this.command(method, `element/${encodeURIComponent(id)}/${path.replace(/^\//, "")}`, body, { mutation: method !== "GET" });
  }

  async closeSession() {
    if (this.closing) return this.closing;
    if (this.creationUnknown || this.closeUnknown) throw new AppiumError("Session cleanup outcome is unknown; resolve it on the Appium server", { method: "DELETE", outcome: "unknown", phase: "cleanup", attemptId: this.lastAttemptId });
    if (!this.sessionId) return;
    const id = this.sessionId;
    const attemptId = randomUUID();
    this.lastAttemptId = attemptId;
    const closing = (async () => {
      try {
        await this.request("DELETE", `/session/${encodeURIComponent(id)}`, undefined, { mutation: true, signal: null, attemptId, operation: "cleanup" });
        this.sessionId = null;
      } catch (error) {
        if (error.code === "appium_session_expired") {
          this.sessionId = null;
          return { expired: true };
        }
        if (error.outcome === "unknown") this.closeUnknown = true;
        throw error;
      }
    })();
    this.closing = closing;
    try { return await closing; }
    finally { if (this.closing === closing) this.closing = null; }
  }
}
