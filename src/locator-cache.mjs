// Persists Jev's decisions to disk so a repeated goal replays without Jev calls.
// Key: (goal, url path, round). Entry: { tool, xpath, frame, brief, valueKey?/option? }.
// The element's stable XPath (from the page script) is what gets stored; the ephemeral
// data-jev-i number is re-resolved against each fresh snapshot and validated by brief.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function cacheKey(goal, url, round) {
  let path = url;
  try { const u = new URL(url); path = u.origin + u.pathname; } catch {}
  const g = String(goal).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
  return `${g} @ ${path} #${round}`;
}

export class LocatorCache {
  constructor(file) { this.file = resolve(file); this.data = null; }

  load() {
    if (this.data) return;
    this.data = {};
    if (existsSync(this.file)) {
      try { this.data = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.data = {}; }
    }
  }

  get(key) { this.load(); return this.data[key] ?? null; }

  put(key, entry) {
    this.load();
    this.data[key] = { ...entry, t: Date.now() };
    this.save();
  }

  evict(key) {
    this.load();
    if (key in this.data) { delete this.data[key]; this.save(); }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get size() { this.load(); return Object.keys(this.data).length; }
}
