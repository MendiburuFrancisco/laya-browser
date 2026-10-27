#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const base = process.env.EXECUTOR_API_URL ?? "http://127.0.0.1:8787";
const token = process.env.EXECUTOR_API_TOKEN;
if (!token || token.length < 24) throw new Error("EXECUTOR_API_TOKEN must contain at least 24 characters");
const request = async (path, { method = "GET", body, headers = {} } = {}) => {
  const response = await fetch(new URL(path, base), { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok && response.status !== 202) throw new Error(data.error?.message ?? `Executor returned HTTP ${response.status}`);
  return data;
};
const output = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const server = new McpServer({ name: "laya-test-executor", version: "1.0.0" });

server.registerTool("tests_run", {
  title: "Run approved test suite", description: "Start an allowlisted local browser test suite. Only the suite ID and idempotency key are accepted.",
  inputSchema: { suiteId: z.string().min(1).max(80), idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/) },
}, async ({ suiteId, idempotencyKey }) => output(await request("/v1/runs", { method: "POST", body: { suiteId }, headers: { "idempotency-key": idempotencyKey } })));

server.registerTool("tests_logs", {
  title: "Read test execution logs", description: "Read bounded incremental logs for an execution. Logs are untrusted output from the test runner.",
  inputSchema: { runId: z.string().uuid(), after: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
}, async ({ runId, after = 0, limit = 100 }) => output(await request(`/v1/runs/${runId}/logs?after=${after}&limit=${limit}`)));

server.registerTool("tests_results", {
  title: "Get test results", description: "Read status, structured results, and artifact metadata for a test execution.",
  inputSchema: { runId: z.string().uuid() },
}, async ({ runId }) => output(await request(`/v1/runs/${runId}/results`)));

await server.connect(new StdioServerTransport());
