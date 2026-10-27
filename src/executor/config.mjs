import { resolve } from "node:path";

const integer = (name, fallback, env, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
};

export function loadExecutorConfig(env = process.env) {
  const token = env.EXECUTOR_API_TOKEN;
  if (typeof token !== "string" || token.length < 24) throw new Error("EXECUTOR_API_TOKEN must contain at least 24 characters");
  return Object.freeze({
    host: env.EXECUTOR_HOST ?? "127.0.0.1",
    port: integer("EXECUTOR_PORT", 8787, env, { min: 1, max: 65535 }),
    token,
    dataDir: resolve(env.EXECUTOR_DATA_DIR ?? ".executor-data"),
    maxQueued: integer("EXECUTOR_MAX_QUEUED", 10, env, { min: 0, max: 1000 }),
    runTimeoutMs: integer("EXECUTOR_RUN_TIMEOUT_MS", 120000, env, { min: 1000, max: 3600000 }),
    shutdownGraceMs: integer("EXECUTOR_SHUTDOWN_GRACE_MS", 10000, env, { min: 0, max: 120000 }),
    maxBodyBytes: integer("EXECUTOR_MAX_BODY_BYTES", 16384, env, { min: 1024, max: 1048576 }),
    maxLogBytes: integer("EXECUTOR_MAX_LOG_BYTES", 5242880, env, { min: 1024, max: 104857600 }),
    maxArtifactBytes: integer("EXECUTOR_MAX_ARTIFACT_BYTES", 52428800, env, { min: 1024, max: 1073741824 }),
    retentionHours: integer("EXECUTOR_RETENTION_HOURS", 24, env, { min: 1, max: 8760 }),
  });
}
