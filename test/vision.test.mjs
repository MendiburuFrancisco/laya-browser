import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { JevBrowser } from "../src/session.mjs";
import { prepareImage, boxPoint, validBox, imageThresholds } from "../src/vision.mjs";
import { invokeBrowser } from "../src/browser-api.mjs";
import { executeCode } from "../src/code-mode.mjs";

const edges = { left: 0.1, top: 0.1, right: 0.3, bottom: 0.3 };
const fixture = "data:text/html," + encodeURIComponent(`<style>body{margin:0}canvas{position:absolute;left:50px;top:50px}</style>
  <canvas width="100" height="100"></canvas><p id="out" style="position:absolute;top:240px">Ready</p>
  <script>const c=document.querySelector('canvas');c.getContext('2d').fillRect(0,0,100,100);c.addEventListener('click',()=>document.querySelector('#out').textContent='Clicked')</script>`);

function stub(b, { visible = 1, confidence = 0.95, box = edges, irreversible = 0, visual = false } = {}) {
  const sent = [];
  b.ask = async (state, questions, options) => {
    sent.push({ state, questions, options });
    const answers = {};
    const done = state.page?.text?.includes("Clicked");
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === "box") answers[name] = { type: "box", box, confidence };
      else if (q.type === "noul") answers[name] = { noul: name === "visible" ? visible : name === "irreversible" ? irreversible : name === "needs_visual" ? +visual : ["done", "done_change", "complete"].includes(name) ? +!!done : name === "q" ? 0.99 : 0 };
      else {
        const keys = Object.keys(q.criteria);
        const choice = name === "tool" ? (done ? "none" : "click") : name === "visual_target" ? "box" : keys[0];
        answers[name] = { choice, probabilities: Object.fromEntries(keys.map(k => [k, +(k === choice)])), confidence: 1 };
      }
    }
    return { answers, ms: 1, tokens: 10 };
  };
  return sent;
}

test("image preparation meets TypeSafe limits and maps resizing/padding to CSS pixels", async () => {
  for (const [width, height] of [[2400, 1800], [100, 1600], [90, 70]]) {
    const buffer = await sharp({ create: { width, height, channels: 3, background: "red" } }).png().toBuffer();
    const image = await prepareImage(buffer, { width, height });
    const asset = image.assets[image.ref];
    const meta = await sharp(Buffer.from(asset.data_base64, "base64")).metadata();
    assert.ok(meta.width >= 280 && meta.width <= 1568);
    assert.ok(meta.height >= 280 && meta.height <= 1568);
    const c = image.content;
    const point = boxPoint({ left: c.left / image.width, right: (c.left + c.width) / image.width, top: c.top / image.height, bottom: (c.top + c.height) / image.height }, image);
    assert.ok(Math.abs(point.x - width / 2) < 0.01);
    assert.ok(Math.abs(point.y - height / 2) < 0.01);
  }
  for (const bad of [null, {}, { ...edges, left: NaN }, { ...edges, left: -1 }, { ...edges, right: 2 }, { ...edges, bottom: 0 }]) assert.equal(validBox(bad), false);
});

test("Box gates absence, invalid/low confidence and clicks a canvas in CSS coordinates at DPR 2", async () => {
  const b = await JevBrowser.launch({ viewport: { width: 500, height: 500 } }); b.cache = null;
  try {
    await b.open(fixture);
    for (const options of [{ visible: 0.1 }, { visible: 0.5 }, { confidence: 0.2 }, { box: { ...edges, left: -1 } }]) {
      stub(b, options);
      const result = await b.box("black square");
      assert.notEqual(result.status, "done"); assert.equal(result.box_id, undefined);
    }
    stub(b);
    const selected = await b.box("black square");
    assert.deepEqual(selected.point, { x: 100, y: 100 });
    const result = await b.actBox({ box_id: selected.box_id, goal: "Click square" });
    assert.equal(result.status, "done");
    assert.equal(await b.page.locator("#out").textContent(), "Clicked");
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Again" }), /stale or unknown/);
    await b.open(fixture);
    const retina = await b.browser.newContext({ viewport: { width: 500, height: 500 }, deviceScaleFactor: 2 });
    const page = await retina.newPage(); await page.goto(fixture); b.page = page;
    const found = await b.box("black square");
    assert.deepEqual(found.point, { x: 100, y: 100 });
    await b.actBox({ box_id: found.box_id, goal: "Click square" });
    assert.equal(await page.locator("#out").textContent(), "Clicked");
    await retina.close();
  } finally { await b.close(); }
});

test("image-only thresholds validate configuration and accept the exact 0.70 boundary", () => {
  assert.deepEqual(imageThresholds((_name, fallback) => fallback), { presence: 0.85, confidence: 0.6 });
  for (const name of ["JEV_IMAGE_MIN_PRESENCE", "JEV_IMAGE_MIN_CONFIDENCE"]) {
    for (const bad of ["", " ", "NaN", "Infinity", "-0.1", "1.1", "invalid"]) {
      assert.throws(() => imageThresholds((key, fallback) => key === name ? bad : fallback), new RegExp(name));
    }
  }
  const before = { presence: process.env.JEV_IMAGE_MIN_PRESENCE, confidence: process.env.JEV_IMAGE_MIN_CONFIDENCE };
  process.env.JEV_IMAGE_MIN_PRESENCE = "0.70";
  process.env.JEV_IMAGE_MIN_CONFIDENCE = "0.70";
  try {
    const b = Object.create(JevBrowser.prototype);
    const image = { width: 500, height: 500, content: { left: 0, top: 0, width: 500, height: 500 }, viewport: { width: 500, height: 500 } };
    assert.equal(b.rememberBox({ box: edges, confidence: 0.70 }, 0.699, image, "square").status, "not_found");
    assert.equal(b.rememberBox({ box: edges, confidence: 0.699 }, 0.70, image, "square").status, "ambiguous");
    const accepted = b.rememberBox({ box: edges, confidence: 0.70 }, 0.70, image, "square");
    assert.equal(accepted.status, "done");
    assert.deepEqual(accepted.thresholds, { presence: 0.70, confidence: 0.70 });
    assert.equal(b.rememberBox({ box: { ...edges, left: -1 }, confidence: 1 }, 1, image, "square").status, "ambiguous");
  } finally {
    for (const [name, value] of [["JEV_IMAGE_MIN_PRESENCE", before.presence], ["JEV_IMAGE_MIN_CONFIDENCE", before.confidence]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("stale screenshots, scrolling, tab switches and action budgets refuse Box actions", async () => {
  const b = await JevBrowser.launch({ viewport: { width: 500, height: 500 } }); b.cache = null;
  try {
    await b.open(fixture); stub(b);
    let selected = await b.box("square");
    await b.page.locator("#out").evaluate(el => el.textContent = "Changed");
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Click" }), /Screenshot changed/);
    selected = await b.box("square");
    await b.page.setViewportSize({ width: 510, height: 500 });
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Click" }), /Screenshot changed/);
    selected = await b.box("square");
    await b.page.evaluate(() => { document.body.style.minHeight = "2000px"; scrollTo(0, 50); });
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Click" }), /Screenshot changed/);
    await b.page.evaluate(() => scrollTo(0, 0));
    selected = await b.box("square");
    const first = b.page; const other = await b.context.newPage(); b.page = first;
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Click" }), /stale or unknown/);
    await other.close();
    selected = await b.box("square");
    b.execution = { remainingCalls: 10, remainingActions: 0 };
    await assert.rejects(b.actBox({ box_id: selected.box_id, goal: "Click" }), /action budget/);
    assert.equal(await b.page.locator("#out").textContent(), "Changed");
  } finally { b.execution = undefined; await b.close(); }
});

test("visual field actions replace text and send Enter; hover and right click use the Box center", async () => {
  const b = await JevBrowser.launch({ viewport: { width: 500, height: 500 } }); b.cache = null;
  try {
    await b.open("data:text/html," + encodeURIComponent(`<input value="old" style="position:absolute;left:50px;top:50px;width:100px;height:100px;box-sizing:border-box">
      <script>const el=document.querySelector('input');el.onkeydown=e=>{if(e.key==='Enter')el.dataset.enter='yes'};el.oncontextmenu=e=>{e.preventDefault();el.dataset.right='yes'};el.onmouseenter=()=>el.dataset.hover='yes'</script>`));
    stub(b);
    for (const action of ["hover", "right_click", "type", "press_enter"]) {
      const found = await b.box("input field");
      const result = await b.actBox({ box_id: found.box_id, goal: "Edit field", action, value: action === "type" ? "new value" : undefined });
      assert.equal(result.status, "done");
    }
    const input = b.page.locator("input");
    assert.equal(await input.inputValue(), "new value");
    for (const attr of ["data-enter", "data-right", "data-hover"]) assert.equal(await input.getAttribute(attr), "yes");
  } finally { await b.close(); }
});

test("check detects visual validation and masks passwords and known secrets in screenshots", async () => {
  const b = await JevBrowser.launch(); b.cache = null;
  try {
    await b.open("data:text/html," + encodeURIComponent('<input type="password" value="hidden"><input value="secret-token"><p>secret-token</p>'));
    b.secrets = new Set(["secret-token"]);
    const sent = stub(b, { visual: true });
    assert.equal(await b.check("Is the square red?"), 0.99);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].options.assets, undefined);
    assert.ok(sent[1].options.assets);
    const image = Object.values(sent[1].options.assets)[0];
    const { data, info } = await sharp(Buffer.from(image.data_base64, "base64")).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    assert.deepEqual(pixel(20, 15), [255, 0, 255], "password masked");
    assert.deepEqual(pixel(200, 15), [255, 0, 255], "known secret input masked");
    assert.ok(!JSON.stringify(sent.map(s => s.state)).includes("secret-token"));
  } finally { await b.close(); }
});

test("do automatically recovers missing DOM targets using Box and preserves irreversible guards", async () => {
  const b = await JevBrowser.launch({ viewport: { width: 500, height: 500 } }); b.cache = null;
  try {
    await b.open(fixture);
    const snapshot = b.snapshot.bind(b);
    b.snapshot = async () => ({ ...await snapshot(), elements: [] });
    const sent = stub(b);
    const result = await b.do("Click the black square", { maxActions: 2 });
    assert.equal(result.status, "done");
    assert.equal(result.rounds[0].visual, true);
    assert.deepEqual(result.rounds[0].box, edges);
    assert.equal(await b.page.locator("#out").textContent(), "Clicked");
    assert.ok(sent.some(s => s.questions.box?.type === "box" && s.options.assets));
    await b.open(fixture); stub(b, { irreversible: 0.99 });
    assert.equal((await b.do("Delete via the square", { maxActions: 1 })).status, "needs_confirmation");
    assert.equal(await b.page.locator("#out").textContent(), "Ready");
  } finally { await b.close(); }
});

test("Code Mode Box actions require exact host authorization and suspend on absent targets", async () => {
  const b = await JevBrowser.launch({ viewport: { width: 500, height: 500 } }); b.cache = null;
  try {
    await b.open(fixture); stub(b, { irreversible: 0.99 });
    const code = `const box = await browser.box({target:'black square'}); return await browser.actBox({box_id:box.box_id,goal:'Delete square'});`;
    const invoke = (method, args, policy) => invokeBrowser(b, method, args, policy);
    assert.equal((await executeCode({ code }, { invoke })).status, "needs_confirmation");
    assert.equal((await executeCode({ code, authorized_goals: ["Other goal"] }, { invoke })).status, "needs_confirmation");
    assert.equal((await executeCode({ code, authorized_goals: ["Delete square"] }, { invoke })).status, "done");
    assert.equal(await b.page.locator("#out").textContent(), "Clicked");
    stub(b, { visible: 0 });
    const stopped = await executeCode({ code: `await browser.box({target:'missing'}); return 'wrong';` }, { invoke });
    assert.equal(stopped.status, "not_found");
  } finally { await b.close(); }
});
