#!/usr/bin/env node
// laya-browser run <flow.json> [--headed] [--json] [--allow-irreversible]
// laya-browser do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]
import { readFileSync } from "node:fs";
import { runFlow } from "../src/flow.mjs";
import { JevBrowser } from "../src/session.mjs";

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const pos = argv.filter(a => !a.startsWith("--"));
const headed = flag("--headed");
const allowIrreversible = flag("--allow-irreversible");

const usage = () => {
  console.error(`usage:
  laya-browser run <flow.json> [--headed] [--json] [--allow-irreversible]
  laya-browser do <url> "<goal>" [key=value ...] [--headed] [--allow-irreversible]`);
  process.exit(2);
};

if (pos[0] === "run" && pos[1]) {
  const flow = JSON.parse(readFileSync(pos[1], "utf8"));
  console.log(`▶ ${flow.name ?? pos[1]}  ${flow.url}`);
  const out = await runFlow(flow, { headed, slowMo: headed ? 300 : 0, allowIrreversible });
  console.log(`\n${out.passed}/${out.steps} steps done · ${out.calls} Jev calls · Jev ${out.jev_ms}ms of ${out.total_ms}ms total`);
  if (flag("--json")) console.log(JSON.stringify(out, null, 1));
  process.exit(out.passed === out.steps ? 0 : 1);
} else if (pos[0] === "do" && pos[1] && pos[2]) {
  const values = Object.fromEntries(pos.slice(3).map(kv => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const b = await JevBrowser.launch({ headed, slowMo: headed ? 300 : 0 });
  try {
    await b.open(pos[1]);
    const r = await b.do(pos[2], { values, allowIrreversible, log: console.log });
    const { rounds, ...rest } = r;
    console.log(JSON.stringify(rest, null, 1));
    process.exitCode = r.status === "done" ? 0 : 1;
  } finally { await b.close(); }
} else usage();
