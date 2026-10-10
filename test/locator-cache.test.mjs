// Offline tests for the locator cache: persistence, eviction, key normalisation. No Jev calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocatorCache, cacheKey } from "../src/locator-cache.mjs";

const tmp = () => join(mkdtempSync(join(tmpdir(), "jev-cache-")), "cache.json");

test("put/get round-trips and persists to disk", () => {
  const file = tmp();
  const c = new LocatorCache(file);
  c.put("k1", { tool: "click", xpath: "//*[@id='b1']", frame: null, brief: 'button "Save"' });

  const fresh = new LocatorCache(file);
  const got = fresh.get("k1");
  assert.equal(got.xpath, "//*[@id='b1']");
  assert.equal(got.tool, "click");
  assert.ok(got.t > 0);
  assert.ok(existsSync(file));
});

test("get returns null for unknown keys; evict removes and persists", () => {
  const file = tmp();
  const c = new LocatorCache(file);
  assert.equal(c.get("nope"), null);

  c.put("k1", { tool: "click", xpath: "//button[1]", frame: null, brief: 'button "Go"' });
  c.evict("k1");
  assert.equal(new LocatorCache(file).get("k1"), null);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {});
});

test("cacheKey normalises goal whitespace/case and strips query strings", () => {
  const a = cacheKey("  Log   In ", "https://x.com/Auth/Login?ref=1", 0);
  const b = cacheKey("log in", "https://x.com/Auth/Login", 0);
  assert.equal(a, b);
  assert.notEqual(cacheKey("log in", "https://x.com/Auth/Login", 0),
                  cacheKey("log in", "https://x.com/Auth/Login", 1));
});

test("a corrupt cache file degrades to empty instead of throwing", () => {
  const file = tmp();
  const c = new LocatorCache(file);
  c.put("k", { tool: "click" });
  const bad = join(tmpdir(), "jev-corrupt.json");
  writeFileSync(bad, "{not json");
  const c2 = new LocatorCache(bad);
  assert.equal(c2.get("k"), null);
});
