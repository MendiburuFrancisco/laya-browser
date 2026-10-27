// Passive session-wide observation. Never intercepts, replays or modifies traffic.
import { randomUUID } from "node:crypto";

export const RESOURCE_TYPES = ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other"];
const BODY_LIMIT = 1024 * 1024;

async function bounded(fn) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Network detail read timed out")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

function body(buffer, contentType = "") {
  if (buffer === null) return null;
  const bytes = buffer.length;
  const textual = /text\/|json|javascript|xml|urlencoded|graphql|svg/i.test(contentType) || !buffer.includes(0) && !contentType;
  const value = buffer.subarray(0, BODY_LIMIT);
  return { data: value.toString(textual ? "utf8" : "base64"), encoding: textual ? "utf8" : "base64", bytes, truncated: bytes > BODY_LIMIT };
}

export class NetworkLog {
  constructor(context, { limit = 500 } = {}) {
    this.entries = new Map(); this.ids = new WeakMap(); this.sequence = 0;
    this.prefix = randomUUID(); this.limit = limit; this.dropped = 0;
    this.handlers = {
      request: request => {
        const id = `${this.prefix}:${++this.sequence}`;
        this.ids.set(request, id);
        this.entries.set(id, { id, request, state: "pending", started_at: new Date().toISOString() });
        if (this.entries.size > this.limit) { this.entries.delete(this.entries.keys().next().value); this.dropped++; }
      },
      response: response => {
        const entry = this.entries.get(this.ids.get(response.request()));
        if (entry) { entry.response = response; entry.state = "receiving"; }
      },
      requestfinished: request => this.finish(request, "finished"),
      requestfailed: request => this.finish(request, "failed"),
    };
    this.context = context;
    for (const [event, handler] of Object.entries(this.handlers)) context.on(event, handler);
  }

  finish(request, state) {
    const entry = this.entries.get(this.ids.get(request));
    if (entry) { entry.state = state; entry.finished_at = new Date().toISOString(); }
  }

  summary(entry) {
    const { id, request, response, state, started_at, finished_at } = entry;
    let page_url = null;
    try { page_url = request.frame().page().url(); } catch {} // service worker requests have no frame
    return { id, url: request.url(), method: request.method(), resource_type: request.resourceType(),
      state, status_code: response?.status() ?? null, started_at, finished_at, page_url,
      redirected_from: this.ids.get(request.redirectedFrom()) ?? null,
      redirected_to: this.ids.get(request.redirectedTo()) ?? null,
      failure: request.failure()?.errorText ?? null };
  }

  list({ resource_types = [], url_contains, page = 1, page_size = 50 } = {}) {
    const entries = [...this.entries.values()].filter(e => (!resource_types.length || resource_types.includes(e.request.resourceType())) &&
      (url_contains === undefined || e.request.url().includes(url_contains)));
    return { requests: entries.slice((page - 1) * page_size, page * page_size).map(e => this.summary(e)),
      total: entries.length, page, page_size, retained: this.entries.size, dropped: this.dropped };
  }

  async get(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown or evicted network request: ${id}. List requests in the current session.`);
    const { request, response } = entry;
    const errors = {};
    const read = async (key, fn) => {
      try { return await bounded(fn); } catch (error) { errors[key] = String(error.message); return null; }
    };
    const request_headers = await read("request_headers", () => request.headersArray());
    const response_headers = response ? await read("response_headers", () => response.headersArray()) : null;
    const contentType = headers => headers?.find(h => h.name.toLowerCase() === "content-type")?.value ?? "";
    const request_body = await read("request_body", () => body(request.postDataBuffer(), contentType(request_headers)));
    let response_body = null;
    let response_body_unavailable;
    if (!response) response_body_unavailable = "No response received";
    else if (entry.state !== "finished") response_body_unavailable = `Request is ${entry.state}; body is not complete`;
    else if (response.status() >= 300 && response.status() < 400) response_body_unavailable = "Redirect response body is unavailable";
    else {
      const size = response_headers?.find(h => h.name.toLowerCase() === "content-length")?.value;
      if (Number(size) > BODY_LIMIT) response_body_unavailable = `Content-Length exceeds the ${BODY_LIMIT}-byte body limit`;
      else response_body = await read("response_body", async () => body(await response.body(), contentType(response_headers)));
    }
    return { ...this.summary(entry), request_headers, request_body, response_headers, response_body,
      ...(response_body_unavailable ? { response_body_unavailable } : {}),
      ...(Object.keys(errors).length ? { errors } : {}) };
  }

  close() {
    for (const [event, handler] of Object.entries(this.handlers)) this.context.off(event, handler);
    this.entries.clear(); this.ids = new WeakMap();
  }
}
