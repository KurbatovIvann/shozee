import { z } from "zod";

export const SHO_RESULT_SCHEMA = "sho-result/2";

export const SHO_UNRECOGNIZED = "unrecognized";

export type ShoUnrecognized = typeof SHO_UNRECOGNIZED;

const knownOr = <Known extends string>(known: readonly Known[]) =>
  z
    .string()
    .transform((value): Known | ShoUnrecognized =>
      (known as readonly string[]).includes(value)
        ? (value as Known)
        : SHO_UNRECOGNIZED,
    );

export const SHO_INTENT_KINDS = [
  "nav",
  "read",
  "write",
  "high",
  "ui",
  "none",
  "read-modifier",
] as const;

export const SHO_EFFECTS = [
  "none",
  "ui",
  "navigate",
  "read",
  "write",
  "destructive",
] as const;

export const SHO_CONFIRMATIONS = ["none", "card", "strong"] as const;

export const SHO_REF_STATUSES = [
  "resolved",
  "ambiguous",
  "unknown",
  "unchecked",
  "previous",
  "context",
] as const;

export const SHO_VARIANT_STATUSES = [
  "resolved",
  "ambiguous",
  "unknown",
  "unspecified",
  "none",
  "unchecked",
] as const;

export const SHO_MATCHES = [
  "exact",
  "form",
  "alias",
  "sound",
  "part",
  "attrs",
  "only",
  "phone",
  "email",
] as const;

export const SHO_CONTACT_KINDS = ["phone", "email"] as const;

export const SHO_CREATES_TYPES = [
  "customer",
  "group",
  "order",
  "product",
  "price_list",
  "counterparty",
] as const;

export const SHO_NEED_REASONS = [
  "missing",
  "ambiguous",
  "unknown",
  "variant_required",
  "unknown_attr",
  "quantity_asks",
  "unit_mismatch",
  "duplicate_line",
  "invalid_value",
  "postomat_limit",
  "ambiguous_role",
  "unsupported",
  "ignored",
  "unparsed",
  "read_as_update",
  "read_as_customer_update",
  "reference",
  "read_as_focus_type",
  "check_reference",
  "read_as_create",
  "read_as_find",
  "language",
  "how_to",
] as const;

export const shoCandidateSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string(),
  productId: z.string().nullable().optional(),
  label: z.string().optional(),
});

export const shoNearCandidateSchema = shoCandidateSchema.extend({
  score: z.number(),
});

export interface ShoSuggestion {
  readonly action: string;
  readonly params: Readonly<Record<string, ShoParam>>;
  readonly attrs?: readonly string[] | undefined;
}

const nearestAndSuggest = {
  nearest: z.array(shoNearCandidateSchema).optional(),
  suggest: z.lazy(() => shoSuggestionSchema).optional(),
};

export const shoRefSchema = z.object({
  text: z.string(),
  status: knownOr(SHO_REF_STATUSES),
  id: z.string().nullable().optional(),
  name: z.string().optional(),
  match: knownOr(SHO_MATCHES).optional(),
  candidates: z.array(shoCandidateSchema).optional(),
  truncated: z.literal(true).optional(),
  command: z.number().int().optional(),
  confidence: z.number().optional(),
  focus: z.union([z.number().int(), z.literal(true)]).optional(),
  by: knownOr(SHO_CONTACT_KINDS).optional(),
  value: z.string().optional(),
  ...nearestAndSuggest,
});

export const shoAttrSchema = z.object({
  text: z.string(),
  variantIds: z.array(z.string()).nullable(),
  confidence: z.number().optional(),
  ...nearestAndSuggest,
});

const variantRefFields = {
  status: knownOr(SHO_VARIANT_STATUSES),
  id: z.string().optional(),
  name: z.string().optional(),
  match: knownOr(SHO_MATCHES).optional(),
  candidates: z.array(shoCandidateSchema).optional(),
  truncated: z.literal(true).optional(),
};

export const shoVariantRefSchema = z.object(variantRefFields);

export const shoVariantParamSchema = z.object({
  ...variantRefFields,
  text: z.string(),
  attrs: z.array(shoAttrSchema),
  confidence: z.number().optional(),
});

export const shoQuantitySchema = z.object({
  text: z.string().nullable(),
  said: z.array(z.string()),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  unitText: z.string().nullable(),
  implicit: z.literal(true).optional(),
  confidence: z.number().optional(),
});

export const shoOrderItemSchema = z.object({
  product: shoRefSchema,
  attrs: z.array(shoAttrSchema),
  variant: shoVariantRefSchema,
  quantity: shoQuantitySchema,
});

export const shoSpanParamSchema = z.object({
  text: z.string(),
  value: z.unknown().optional(),
  confidence: z.number().optional(),
});

export const shoPaymentPartSchema = z.object({
  method: z.string().nullable(),
  minor: z.number().nullable(),
  currency: z.string(),
  rest: z.literal(true).optional(),
});

export const shoEnumParamSchema = z.object({
  value: z.string(),
  parts: z.array(shoPaymentPartSchema).optional(),
});

export const shoParamSchema = z.union([
  z.array(shoOrderItemSchema),
  z.array(shoAttrSchema),
  z.array(shoRefSchema),
  z.array(shoSpanParamSchema),
  z.array(z.string()),
  shoVariantParamSchema,
  shoRefSchema,
  shoSpanParamSchema,
  shoEnumParamSchema,
]);

export const shoSuggestionSchema: z.ZodType<ShoSuggestion> = z.object({
  action: z.string(),
  params: z.record(z.string(), shoParamSchema),
  attrs: z.array(z.string()).optional(),
});

export const shoNeedSchema = z.object({
  path: z.string(),
  reason: knownOr(SHO_NEED_REASONS),
  blocking: z.boolean(),
  span: shoSpanParamSchema.optional(),
});

export const shoConfidenceSchema = z.object({
  action: z.number(),
  margin: z.number(),
  certainty: z.number(),
  spans: z.number(),
});

export const shoCreatesSchema = z.object({
  type: knownOr(SHO_CREATES_TYPES),
  name: z.string().nullable(),
});

export const shoCommandSchema = z.object({
  text: z.string(),
  action: z.string(),
  kind: knownOr(SHO_INTENT_KINDS),
  effect: knownOr(SHO_EFFECTS),
  confirm: knownOr(SHO_CONFIRMATIONS),
  params: z.record(z.string(), shoParamSchema),
  needs: z.array(shoNeedSchema),
  ready: z.boolean(),
  catalogued: z.boolean(),
  confidence: shoConfidenceSchema,
  refPrevious: z.record(z.string(), z.number()),
  domain: z.string().optional(),
  verb: z.string().optional(),
  refines: z.string().optional(),
  creates: shoCreatesSchema.optional(),
});

export const shoContextInfoSchema = z.object({
  version: z.number().int(),
  revision: z.string().nullable(),
});

export const shoResultSchema = z.object({
  schema: z.string(),
  raw: z.string().nullable(),
  text: z.string(),
  segments: z.array(z.string()),
  tooMany: z.boolean(),
  commands: z.array(shoCommandSchema),
  first: shoCommandSchema,
  context: shoContextInfoSchema.nullable(),
});

export type ShoIntentKind = (typeof SHO_INTENT_KINDS)[number] | ShoUnrecognized;
export type ShoEffect = (typeof SHO_EFFECTS)[number] | ShoUnrecognized;
export type ShoConfirmation =
  (typeof SHO_CONFIRMATIONS)[number] | ShoUnrecognized;
export type ShoNeedReason = (typeof SHO_NEED_REASONS)[number] | ShoUnrecognized;
export type ShoRefStatus = (typeof SHO_REF_STATUSES)[number] | ShoUnrecognized;
export type ShoRecordType = (typeof SHO_CREATES_TYPES)[number];

export type ShoCandidate = z.infer<typeof shoCandidateSchema>;
export type ShoNearCandidate = z.infer<typeof shoNearCandidateSchema>;
export type ShoRef = z.infer<typeof shoRefSchema>;
export type ShoAttr = z.infer<typeof shoAttrSchema>;
export type ShoVariantRef = z.infer<typeof shoVariantRefSchema>;
export type ShoVariantParam = z.infer<typeof shoVariantParamSchema>;
export type ShoQuantity = z.infer<typeof shoQuantitySchema>;
export type ShoOrderItem = z.infer<typeof shoOrderItemSchema>;
export type ShoSpanParam = z.infer<typeof shoSpanParamSchema>;
export type ShoEnumParam = z.infer<typeof shoEnumParamSchema>;
export type ShoParam = z.infer<typeof shoParamSchema>;
export type ShoNeed = z.infer<typeof shoNeedSchema>;
export type ShoConfidence = z.infer<typeof shoConfidenceSchema>;
export type ShoCommand = z.infer<typeof shoCommandSchema>;
export type ShoContextInfo = z.infer<typeof shoContextInfoSchema>;
export type ShoResult = z.infer<typeof shoResultSchema>;

export const shoBlockingNeeds = (command: ShoCommand): readonly ShoNeed[] =>
  command.needs.filter((need) => need.blocking);

export const shoAsksDialogueModel = (command: ShoCommand): boolean =>
  command.needs.some(
    (need) => need.reason === "how_to" || need.reason === "language",
  );
