// Minimal client for the Typesafe System One API (model: Jev).
// Jev answers typed questions over a state object; it never generates text.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const API_URL = process.env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone";
export const MODEL = process.env.JEV_MODEL || "jev-latest";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEY_NAMES = ["TYPESAFE_API_KEY"];
let cachedKey;
export function apiKey() {
  if (cachedKey) return cachedKey;
  for (const k of KEY_NAMES) if (process.env[k]) return (cachedKey = process.env[k]);
  // The MCP server skips the working directory's .env: as a plugin that is the user's project,
  // and a key found there was not given to this server.
  const files = process.env.JEV_BROWSER_MCP === "1" ? [resolve(ROOT, ".env")] : [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")];
  for (const p of files) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]+)"?/);
      if (m && KEY_NAMES.includes(m[1])) return (cachedKey = m[2]);
    }
  }
  throw new Error("No TypeSafe API key: set TYPESAFE_API_KEY (as a Claude Code plugin: /plugin, then configure jev-browser) or put it in .env");
}

// questions: { name: { type: "noul" | "choice" | "score", instructions, criteria? } }
export async function jev(state, questions, { retries = 2, timeout = 60_000 } = {}) {
  const key = apiKey();
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    let res, body;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: AbortSignal.timeout(timeout),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw e;
    }
    const ms = Math.round(performance.now() - t);
    if (res.ok) return { answers: body.answers, ms, tokens: body.usage?.input_tokens ?? 0 };
    if (attempt < retries && (res.status === 429 || res.status >= 500)) { await sleep(800 * (attempt + 1)); continue; }
    throw new Error(`Jev ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}
