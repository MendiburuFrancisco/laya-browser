// E2E cache demo: runs the same login goal twice; the second run should replay from disk.
import { JevBrowser } from "../src/session.mjs";

const run = async n => {
  const b = await JevBrowser.launch({ headed: false });
  try {
    await b.open("https://test-patient-web.wehealthy.ar");
    const r = await b.do("Click 'Iniciar sesión', fill in the login form and submit it", {
      values: { email: process.env.WEHEALTHY_EMAIL, password: process.env.WEHEALTHY_PASSWORD },
      maxActions: 8,
      log: console.log,
    });
    console.log(`\n=== RUN ${n}: status=${r.status} jev_calls=${r.jev_calls} ms=${r.ms} cache=${JSON.stringify(r.cache ?? null)}`);
    console.log("logged in:", /Home/.test(r.url) ? "YES" : `NO (${r.url})`);
  } finally { await b.close(); }
};

await run(1);
await run(2);
