// Minimal client for the Typesafe System One API (model: Jev).
// Jev answers typed questions over a state object; it never generates text.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Read only recognised settings from .env, without modifying the process environment.
function setting(name, fallback) {
  if (process.env[name] !== undefined) return process.env[name];
  for (const p of [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m?.[1] === name) return m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return fallback;
}
export const BACKEND = setting("JEV_BACKEND", "jev");
if (!["jev", "laya"].includes(BACKEND)) throw new Error(`Unknown JEV_BACKEND: ${BACKEND}`);
export const API_URL = setting("JEV_API_URL", BACKEND === "laya" ? "http://127.0.0.1:8791/v1/systemone" : "https://api.typesafe.ai/v1/systemone");
export const MODEL = setting("JEV_MODEL", BACKEND === "laya" ? "cklxx/laya-browser" : "jev-latest");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEY_NAMES = ["TYPESAFE_API_KEY"];
let cachedKey;
export function apiKey() {
  if (cachedKey) return cachedKey;
  for (const k of KEY_NAMES) if (process.env[k]) return (cachedKey = process.env[k]);
  for (const p of [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]+)"?/);
      if (m && KEY_NAMES.includes(m[1])) return (cachedKey = m[2]);
    }
  }
  throw new Error("No TypeSafe API key: set TYPESAFE_API_KEY in the environment or in .env");
}

// questions: { name: { type: "noul" | "choice" | "score", instructions, criteria? } }
export async function jev(state, questions, { retries = 2, timeout = 60_000, signal } = {}) {
  const key = BACKEND === "laya" ? null : apiKey();
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const t = performance.now();
    let res, body;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      signal?.throwIfAborted();
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw e;
    }
    const ms = Math.round(performance.now() - t);
    if (res.ok) return { answers: body.answers, ms, tokens: body.usage?.input_tokens ?? 0 };
    if (attempt < retries && (res.status === 429 || res.status >= 500)) { await sleep(800 * (attempt + 1)); continue; }
    throw new Error(`${BACKEND} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}
