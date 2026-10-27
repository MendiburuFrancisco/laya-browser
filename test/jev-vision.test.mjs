import { test } from "node:test";
import assert from "node:assert/strict";

test("visual requests opt into images, preserve pinned models, upgrade stable aliases and reject Laya/old Jev", async () => {
  const keys = ["JEV_BACKEND", "JEV_MODEL", "TYPESAFE_API_KEY", "JEV_API_URL"];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const fetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, input) => {
    sent.push({ headers: input.headers, ...JSON.parse(input.body) });
    return { ok: true, json: async () => ({ answers: {}, usage: { input_tokens: 7 } }) };
  };
  try {
    process.env.TYPESAFE_API_KEY = "fixture-only";
    process.env.JEV_API_URL = "http://fixture.invalid/v1/systemone";
    for (const [i, [backend, model, expected]] of [["jev", "jev-latest", "jev-preview"], ["jev", "jev-1.14.0", "jev-1.14.0"], ["jev", "jev-1.13.0", null], ["laya", "local", null]].entries()) {
      process.env.JEV_BACKEND = backend; process.env.JEV_MODEL = model;
      const { jev } = await import(`../src/jev.mjs?vision-test=${i}`);
      const state = { screenshot: "asset-ref" }, questions = { box: { type: "box", instructions: "target in `screenshot`" } };
      const options = { assets: { "asset-ref": { type: "image", format: "png", data_base64: "fixture" } }, retries: 0 };
      if (!expected) {
        const count = sent.length;
        await assert.rejects(jev(state, questions, options), backend === "laya" ? /only.*Jev/ : /1\.14/);
        assert.equal(sent.length, count);
      } else {
        const r = await jev(state, questions, options);
        assert.equal(r.tokens, 7);
        assert.equal(sent.at(-1).model, expected);
        assert.equal(sent.at(-1).headers["TypeSafe-Danger-Zone-Images"], "true");
        assert.deepEqual(sent.at(-1).assets, options.assets);
        await jev({}, { q: { type: "noul", instructions: "Ready?" } });
        assert.equal(sent.at(-1).model, model);
        assert.equal(sent.at(-1).headers["TypeSafe-Danger-Zone-Images"], undefined);
        assert.equal(sent.at(-1).assets, undefined);
      }
    }
  } finally {
    globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
