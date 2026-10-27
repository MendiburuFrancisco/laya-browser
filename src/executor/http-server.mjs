import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import { SUITES } from "./catalog.mjs";
import { createRunSchema, idempotencyKeySchema, runIdSchema, cursorSchema, logLimitSchema } from "./schemas.mjs";

const json = (res, status, body, requestId) => { const bytes = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" }); res.end(bytes); };
const error = (res, status, code, message, requestId) => json(res, status, { error: { code, message, requestId } }, requestId);
const matchesToken = (req, expected) => {
  const header = req.headers.authorization ?? "", match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1]), wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
};
const readJson = async (req, maxBytes) => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) { const e = new Error("Request body too large"); e.status = 413; throw e; } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { const e = new Error("Request body must be valid JSON"); e.status = 400; throw e; }
};
const publicRun = run => ({ runId: run.runId, suiteId: run.suiteId, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, ...(run.error ? { error: run.error } : {}) });

export function createExecutorServer({ config, store, queue }) {
  let ready = false;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url, "http://executor.local"), path = url.pathname;
      if (req.method === "GET" && path === "/healthz") return json(res, 200, { status: "ok" }, requestId);
      if (req.method === "GET" && path === "/readyz") return json(res, ready ? 200 : 503, { status: ready ? "ready" : "starting" }, requestId);
      if (!matchesToken(req, config.token)) return error(res, 401, "UNAUTHORIZED", "Valid bearer token required", requestId);
      if (req.method === "GET" && path === "/v1/suites") return json(res, 200, { suites: SUITES }, requestId);
      if (req.method === "POST" && path === "/v1/runs") {
        let payload;
        try { payload = createRunSchema.parse(await readJson(req, config.maxBodyBytes)); }
        catch (e) { return error(res, e.status ?? 400, "INVALID_REQUEST", e.status === 413 ? "Request body too large" : "Invalid JSON body or schema", requestId); }
        const header = req.headers["idempotency-key"], parsed = idempotencyKeySchema.safeParse(header);
        if (!parsed.success) return error(res, 400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key header is required and must be 8-128 safe characters", requestId);
        const submitted = await queue.submit(payload.suiteId, parsed.data);
        if (submitted.error) {
          const map = { SUITE_NOT_ALLOWED: [400, "Suite is not enabled"], IDEMPOTENCY_CONFLICT: [409, "Idempotency key was already used with a different request"], QUEUE_FULL: [429, "Executor queue is full"], SHUTTING_DOWN: [503, "Executor is shutting down"] };
          const [status, message] = map[submitted.error] ?? [500, "Could not submit run"];
          return error(res, status, submitted.error, message, requestId);
        }
        const run = submitted.run;
        return json(res, submitted.existing ? 200 : 202, { ...publicRun(run), links: { status: `/v1/runs/${run.runId}`, logs: `/v1/runs/${run.runId}/logs`, results: `/v1/runs/${run.runId}/results` } }, requestId);
      }
      const match = /^\/v1\/runs\/([^/]+)(?:\/(logs|results|artifacts\/([^/]+)))?$/.exec(path);
      if (!match) return error(res, 404, "NOT_FOUND", "Route not found", requestId);
      const parsedId = runIdSchema.safeParse(match[1]);
      if (!parsedId.success) return error(res, 404, "RUN_NOT_FOUND", "Run not found", requestId);
      const run = store.get(parsedId.data);
      if (!run) return error(res, 404, "RUN_NOT_FOUND", "Run not found", requestId);
      if (req.method !== "GET") return error(res, 405, "METHOD_NOT_ALLOWED", "Only GET is allowed for this resource", requestId);
      if (!match[2]) return json(res, 200, publicRun(run), requestId);
      if (match[2] === "logs") {
        const after = cursorSchema.safeParse(url.searchParams.get("after") ?? 0), limit = logLimitSchema.safeParse(url.searchParams.get("limit") ?? 100);
        if (!after.success || !limit.success) return error(res, 400, "INVALID_CURSOR", "after must be a non-negative integer and limit must be 1-200", requestId);
        const logs = await store.logs(run.runId, after.data, limit.data);
        return json(res, 200, { runId: run.runId, ...logs }, requestId);
      }
      if (match[2] === "results") {
        const result = await store.result(run.runId);
        if (result) return json(res, 200, result, requestId);
        if (["queued", "running"].includes(run.status)) return json(res, 202, { ...publicRun(run), pending: true }, requestId);
        return json(res, 200, { schemaVersion: 1, runId: run.runId, suiteId: run.suiteId, status: run.status,
          decisionBackend: run.decisionBackend ?? "fixture", startedAt: run.startedAt, finishedAt: run.finishedAt,
          summary: { total: 0, passed: 0, failed: run.status === "passed" ? 0 : 1, skipped: 0 }, cases: [],
          ...(run.error ? { error: run.error } : {}), artifacts: [] }, requestId);
      }
      const artifact = await store.openArtifact(run.runId, match[3], config.maxArtifactBytes);
      if (!artifact) return error(res, 404, "ARTIFACT_NOT_FOUND", "Artifact not found", requestId);
      res.writeHead(200, { "content-type": match[3].endsWith(".webm") ? "video/webm" : "application/octet-stream", "content-length": artifact.size, "content-disposition": `attachment; filename="${basename(artifact.path)}"`, "x-content-type-options": "nosniff", "cache-control": "no-store", "x-request-id": requestId });
      artifact.handle.createReadStream({ autoClose: true }).pipe(res);
    } catch (e) {
      if (res.headersSent) { res.destroy(e); return; }
      error(res, 500, "INTERNAL_ERROR", "Executor request failed", requestId);
    }
  });
  return { server, setReady(value) { ready = value; } };
}
