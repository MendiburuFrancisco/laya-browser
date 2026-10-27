#!/usr/bin/env node
import { loadExecutorConfig } from "../src/executor/config.mjs";
import { RunStore } from "../src/executor/run-store.mjs";
import { RunQueue } from "../src/executor/queue.mjs";
import { createExecutorServer } from "../src/executor/http-server.mjs";
import { once } from "node:events";

const config = loadExecutorConfig();
const store = new RunStore(config.dataDir);
await store.initialize();
const queue = new RunQueue(store, config);
const { server, setReady } = createExecutorServer({ config, store, queue });
const retention = setInterval(() => void store.pruneExpired(Date.now(), config.retentionHours * 3600000).catch(e => process.stderr.write(`executor retention error: ${e.message}\n`)), 3600000);
retention.unref();
server.listen(config.port, config.host, () => { setReady(true); queue.resume(); process.stderr.write(`laya test executor listening on ${config.host}:${config.port}\n`); });

let closing;
const shutdown = signal => {
  if (closing) return closing;
  setReady(false); clearInterval(retention);
  closing = (async () => {
    process.stderr.write(`laya test executor shutting down (${signal})\n`);
    const closed = once(server, "close");
    server.close();
    await queue.shutdown();
    await closed;
    await store.release();
    process.exitCode = 0;
  })();
  return closing;
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
