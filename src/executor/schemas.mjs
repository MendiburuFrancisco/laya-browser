import { z } from "zod";

export const createRunSchema = z.object({ suiteId: z.string().min(1).max(80) }).strict();
export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const runIdSchema = z.string().uuid();
export const cursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
export const logLimitSchema = z.coerce.number().int().min(1).max(200).default(100);
