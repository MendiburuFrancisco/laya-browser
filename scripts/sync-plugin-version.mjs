#!/usr/bin/env node
// Keeps the source plugin manifest on package.json's version and checks its fork launcher.
// Runs from `npm version` (the "version" script), so the bump commit carries all three files.
//   node scripts/sync-plugin-version.mjs --check   exits 1 if they disagree (CI, release)
import { readFileSync, writeFileSync } from "node:fs";

const read = p => JSON.parse(readFileSync(p, "utf8"));
const { version } = read("package.json");
const plugin = read(".claude-plugin/plugin.json");
const mcp = read(".mcp.json");
const launcher = mcp.mcpServers["laya-browser"];
const entry = "${CLAUDE_PLUGIN_ROOT}/bin/laya-browser-mcp.mjs";

if (process.argv.includes("--check")) {
  const bad = [plugin.version !== version && `.claude-plugin/plugin.json has ${plugin.version}`, (launcher.command !== "node" || launcher.args.length !== 1 || launcher.args[0] !== entry) && ".mcp.json does not launch the fork's source server"].filter(Boolean);
  if (bad.length) { console.error(`package.json is ${version}, but ${bad.join(" and ")}. Run: node scripts/sync-plugin-version.mjs`); process.exit(1); }
} else {
  plugin.version = version;
  launcher.command = "node";
  launcher.args = [entry];
  writeFileSync(".claude-plugin/plugin.json", JSON.stringify(plugin, null, 2) + "\n");
  writeFileSync(".mcp.json", JSON.stringify(mcp, null, 2) + "\n");
}
