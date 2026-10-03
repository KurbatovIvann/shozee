import { z } from "zod";

import {
  SHO_CREATES_TYPES,
  shoCommandSchema,
  shoResultSchema,
} from "./result.js";

export const SHO_MAX_TEXT_LENGTH = 400;
export const SHO_MAX_CONTEXT_BYTES = 8 * 1024 * 1024;
export const SHO_MAX_PARSE_BYTES = 256 * 1024;

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

export const SHO_CONTEXT_LIMITS = {
  products: 20_000,
  variantsPerProduct: 200,
  variants: 100_000,
  customers: 50_000,
  counterparties: 50_000,
  groups: 2_000,
  priceLists: 2_000,
  id: 64,
  name: 120,
  aliases: 10,
  revision: 128,
} as const;

export const shoPreviousSchema = z.object({
  command: shoCommandSchema,
  at: z.union([z.string(), z.number()]).optional(),
});

export const SHO_MOST_FOCUS = 8;

export const SHO_FOCUS_HOWS = [
  "created",
  "opened",
  "shown",
  "named",
  "listed",
] as const;

export const shoFocusEntrySchema = z.strictObject({
  type: z.enum(SHO_CREATES_TYPES),
  id: z.string().max(SHO_CONTEXT_LIMITS.id),
  name: z.string().max(SHO_CONTEXT_LIMITS.name),
  how: z.enum(SHO_FOCUS_HOWS),
  turns: z.number().int().nonnegative().optional(),
  earlier: z.literal(true).optional(),
  count: z.number().int().nonnegative().optional(),
});

export const shoFocusSchema = z.array(shoFocusEntrySchema).max(SHO_MOST_FOCUS);

export const shoParseRequestSchema = z.object({
  requestId: z.string().min(1),
  companyId: z.string().min(1),
  contextKey: shoContextKeySchema,
  fingerprint: z.string().min(1),
  text: z.string().min(1).max(SHO_MAX_TEXT_LENGTH),
  now: shoNowSchema,
  previous: shoPreviousSchema.optional(),
  focus: shoFocusSchema.optional(),
  deadlineMs: z.number().int().positive(),
  debug: z.boolean(),
});

export const shoParseResponseSchema = z.object({
  model: z.object({ id: z.string(), md5: z.string() }),
  contextRevision: z.string().nullable(),
  result: shoResultSchema,
  ms: z.number(),
});

export const SHO_CONTEXT_LIST_NAMES = [
  "products",
  "customers",
  "groups",
  "priceLists",
  "counterparties",
] as const;

export const SHO_SALE_UNITS = [
  "pcs",
  "pair",
  "pack",
  "box",
  "set",
  "roll",
  "bag",
  "bottle",
  "can",
  "bucket",
  "sheet",
  "portion",
  "service",
  "hour",
  "kg",
  "g",
  "t",
  "l",
  "ml",
  "m",
  "m2",
  "m3",
] as const;

const NON_BLANK = /\S/;

const filled = (most: number) => z.string().min(1).max(most).regex(NON_BLANK);

const label = filled(SHO_CONTEXT_LIMITS.name);
const flag = z.boolean().optional();

const idsAreUnique = (items: readonly { readonly id: string }[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;

export const shoContextRecordSchema = z.strictObject({
  id: filled(SHO_CONTEXT_LIMITS.id),
  name: label,
  aliases: z.array(label).max(SHO_CONTEXT_LIMITS.aliases).optional(),
});

const recordList = (most: number) =>
  z.array(shoContextRecordSchema).max(most).refine(idsAreUnique).optional();

export const shoContextVariantSchema = shoContextRecordSchema.extend({
  values: z.union([z.array(label), z.record(label, label)]).optional(),
});

export const shoContextProductSchema = shoContextRecordSchema.extend({
  brand: label.optional(),
  unit: z.enum(SHO_SALE_UNITS).optional(),
  variants: z
    .array(shoContextVariantSchema)
    .max(SHO_CONTEXT_LIMITS.variantsPerProduct)
    .refine(idsAreUnique)
    .optional(),
});

const variantCount = (
  products: readonly { readonly variants?: readonly unknown[] | undefined }[],
): number =>
  products.reduce(
    (count, product) => count + (product.variants?.length ?? 0),
    0,
  );

export const shoContextSchema = z.strictObject({
  version: z.literal(2),
  revision: filled(SHO_CONTEXT_LIMITS.revision).optional(),
  capabilities: z.strictObject({ stock: flag, fiscal: flag }).optional(),
  products: z
    .array(shoContextProductSchema)
    .max(SHO_CONTEXT_LIMITS.products)
    .refine(idsAreUnique)
    .refine((products) => variantCount(products) <= SHO_CONTEXT_LIMITS.variants)
    .optional(),
  customers: recordList(SHO_CONTEXT_LIMITS.customers),
  groups: recordList(SHO_CONTEXT_LIMITS.groups),
  priceLists: recordList(SHO_CONTEXT_LIMITS.priceLists),
  counterparties: recordList(SHO_CONTEXT_LIMITS.counterparties),
  partial: z.array(z.enum(SHO_CONTEXT_LIST_NAMES)).optional(),
});

export const shoContextUploadSchema = z.object({
  fingerprint: z.string().min(1),
  context: shoContextSchema,
});

export const SHO_PHRASES_LIMIT = 1000;
export const shoPhrasesLimitSchema = z.int().min(1).max(SHO_PHRASES_LIMIT);

export const shoPhrasesQuerySchema = z.object({
  companyId: z.string().min(1),
  limit: shoPhrasesLimitSchema,
});

export const shoPhrasesResponseSchema = z.object({
  phrases: z.array(z.string()),
});

export const shoHealthResponseSchema = z.object({ status: z.literal("ok") });
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
export type ShoFocusEntry = z.infer<typeof shoFocusEntrySchema>;
export type ShoFocusHow = (typeof SHO_FOCUS_HOWS)[number];
export type ShoParseRequest = z.infer<typeof shoParseRequestSchema>;
export type ShoParseResponse = z.infer<typeof shoParseResponseSchema>;
export type ShoContext = z.infer<typeof shoContextSchema>;
export type ShoContextRecord = z.infer<typeof shoContextRecordSchema>;
export type ShoContextProduct = z.infer<typeof shoContextProductSchema>;
export type ShoContextVariant = z.infer<typeof shoContextVariantSchema>;
export type ShoContextListName = (typeof SHO_CONTEXT_LIST_NAMES)[number];
export type ShoSaleUnit = (typeof SHO_SALE_UNITS)[number];
export type ShoContextUpload = z.infer<typeof shoContextUploadSchema>;
export type ShoPhrasesResponse = z.infer<typeof shoPhrasesResponseSchema>;
export type ShoErrorResponse = z.infer<typeof shoErrorResponseSchema>;
export type ShoErrorCode = (typeof SHO_ERROR_CODES)[number];
