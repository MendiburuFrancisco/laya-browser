#!/usr/bin/env node
// Watch laya-browser drive x.com logged out (read-only). Headed with decision highlights.
//   node examples/x-profile-demo.mjs
// X serves a blank page to headless Chromium, so this must run headed.
import { JevBrowser } from "../src/index.mjs";

const b = await JevBrowser.launch({ headed: true, slowMo: 250, highlight: true });
const log = s => console.log(s);
const step = async (goal, opts = {}) => {
  console.log(`\n▶ ${goal}`);
  const r = await b.do(goal, { log, ...opts });
  console.log(`  = ${r.status}${r.info ? ` (${r.info})` : ""}  ${r.jev_calls} Jev calls, ${(r.ms / 1000).toFixed(1)}s  → ${r.url}`);
  if (r.pending) console.log("  pending:", r.pending);
  return r;
};
const check = async q => console.log(`\n? ${q}\n  p_yes = ${(await b.check(q)).toFixed(2)}`);

try {
  console.log("▶ open https://x.com/AnthropicAI");
  await b.open("https://x.com/AnthropicAI");
  await check("Is this the Anthropic profile page on X?");
  await check("Does the profile show more than 1 million followers?");
  await step("Open the Media tab of this profile");
  await step("Go to the Posts tab of this profile");
  await step("Expand the first post so its full text is shown");
  await step("Open the list of accounts Anthropic follows");
  await step("Follow Anthropic");   // logged out: expect a login prompt, not a follow
} finally {
  console.log("\nclosing in 5s…");
  await new Promise(r => setTimeout(r, 5000));
  await b.close();
}
