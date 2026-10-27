export class AppiumError extends Error {
  constructor(message, { status, method, path, outcome = "known" } = {}) {
    super(message);
    this.name = "AppiumError";
    this.httpStatus = status;
    this.code = "appium_error";
    this.method = method;
    this.path = path;
    this.outcome = outcome;
    this.diagnostic = { phase: mutationPhase(method), outcome };
  }
}

const mutationPhase = method => ["POST", "DELETE"].includes(method) ? "mobile_action" : "mobile_observation";

export class AppiumClient {
  constructor({ url = process.env.APPIUM_URL ?? "http://127.0.0.1:4723", fetchImpl = fetch, timeoutMs = 15000, createTimeoutMs = 90000 } = {}) {
    this.baseUrl = new URL(url);
    if (!["http:", "https:"].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) throw new TypeError("Appium URL must be HTTP(S) without credentials, query or fragment");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.createTimeoutMs = createTimeoutMs;
    this.sessionId = null;
  }

  async request(method, path, body, { mutation = false, timeoutMs = this.timeoutMs, signal = this.getSignal?.() } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response, payload;
    try {
      response = await this.fetch(new URL(path.replace(/^\//, ""), this.baseUrl.href.endsWith("/") ? this.baseUrl : `${this.baseUrl.href}/`), {
        method, headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      payload = await response.json();
    } catch {
      throw new AppiumError(`Appium ${method} response unavailable or invalid`, { method, path, outcome: mutation ? "unknown" : "known" });
    } finally { clearTimeout(timer); }
    if (!response.ok || payload?.value?.error) {
      // Server messages may echo typed secrets or XPath text. Report only the protocol code.
      throw new AppiumError(`Appium ${method}: ${payload?.value?.error ?? `HTTP ${response.status}`}`, { status: response.status, method, path });
    }
    return payload?.value ?? payload;
  }

  async createSession(capabilities) {
    if (this.sessionId) throw new AppiumError("Appium session already exists");
    if (this.creating) throw new AppiumError("Appium session creation is already in progress");
    if (this.creationUnknown) throw new AppiumError("Previous session creation outcome is unknown; resolve it on the Appium server before creating another session", { outcome: "unknown" });
    let result;
    this.creating = true;
    try {
      result = await this.request("POST", "/session", { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, { mutation: true, timeoutMs: this.createTimeoutMs });
    } catch (error) { if (error.outcome === "unknown") this.creationUnknown = true; throw error; }
    finally { this.creating = false; }
    const id = result?.sessionId ?? result?.session_id;
    if (!id) {
      this.creationUnknown = true;
      throw new AppiumError("Appium created a session without returning its session id", { method: "POST", path: "/session", outcome: "unknown" });
    }
    this.sessionId = id;
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
    if (this.creationUnknown || this.closeUnknown) throw new AppiumError("Session cleanup outcome is unknown; resolve it on the Appium server", { method: "DELETE", outcome: "unknown" });
    if (!this.sessionId) return;
    const id = this.sessionId;
    this.closing = this.request("DELETE", `/session/${encodeURIComponent(id)}`, undefined, { mutation: true, signal: null });
    try {
      await this.closing;
    } catch (error) { if (error.outcome === "unknown") this.closeUnknown = true; throw error; }
    finally { this.closing = null; }
    this.sessionId = null;
  }
}
