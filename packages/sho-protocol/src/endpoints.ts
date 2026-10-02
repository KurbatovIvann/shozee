import { z } from "zod";

import { shoCommandSchema, shoResultSchema } from "./result.js";

export const SHO_MAX_TEXT_LENGTH = 400;

export const SHO_MAX_CONTEXT_BYTES = 8 * 1024 * 1024;

export const SHO_CONTEXT_KEY_PATTERN =
  /^[0-9A-Za-z_-]{1,64}:[0-9A-Za-z]{1,64}$/;

export const shoContextKeySchema = z.string().regex(SHO_CONTEXT_KEY_PATTERN);

export const shoContextKey = (companyId: string, scopeHash: string): string =>
  `${companyId}:${scopeHash}`;

export const shoModelStampSchema = z.object({
  id: z.string(),
  md5: z.string(),
  catalogue: z.string(),
  labelsMd5: z.string(),
  runtime: z.string(),
});

export const shoModelResponseSchema = z.object({
  model: shoModelStampSchema,
  actions: z.array(z.string()),
  workers: z.number().int().nonnegative(),
});

export const shoNowSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  day: z.number().int(),
  hour: z.number().int(),
  minute: z.number().int(),
});

export const shoPreviousSchema = z.object({
  command: shoCommandSchema,
  at: z.union([z.string(), z.number()]).optional(),
});

export const shoParseRequestSchema = z.object({
  requestId: z.string().min(1),
  companyId: z.string().min(1),
  contextKey: shoContextKeySchema,
  fingerprint: z.string().min(1),
  text: z.string().min(1).max(SHO_MAX_TEXT_LENGTH),
  now: shoNowSchema,
  previous: shoPreviousSchema.optional(),
  deadlineMs: z.number().int().positive(),
  debug: z.boolean(),
});

export const shoParseResponseSchema = z.object({
  model: z.object({ id: z.string(), md5: z.string() }),
  contextRevision: z.string().nullable(),
  result: shoResultSchema,
  ms: z.number(),
});

export const shoContextUploadSchema = z.object({
  fingerprint: z.string().min(1),
  context: z.unknown(),
});

export const shoPhrasesResponseSchema = z.object({
  phrases: z.array(z.string()),
});

export const shoReadyResponseSchema = z.object({ ready: z.boolean() });

export const SHO_ERROR_CODES = [
  "context_required",
  "context_limit",
  "busy",
  "deadline",
  "input",
] as const;

export const shoErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export type ShoModelStamp = z.infer<typeof shoModelStampSchema>;
export type ShoModelResponse = z.infer<typeof shoModelResponseSchema>;
export type ShoNow = z.infer<typeof shoNowSchema>;
export type ShoPrevious = z.infer<typeof shoPreviousSchema>;
export type ShoParseRequest = z.infer<typeof shoParseRequestSchema>;
export type ShoParseResponse = z.infer<typeof shoParseResponseSchema>;
export type ShoContextUpload = z.infer<typeof shoContextUploadSchema>;
export type ShoPhrasesResponse = z.infer<typeof shoPhrasesResponseSchema>;
export type ShoErrorResponse = z.infer<typeof shoErrorResponseSchema>;
export type ShoErrorCode = (typeof SHO_ERROR_CODES)[number];
