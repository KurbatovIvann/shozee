import { z } from "zod";

export const JUDGMENT_REFUSAL_REASONS = [
  "timeout",
  "rate_limited",
  "overloaded",
  "rejected",
  "unavailable",
] as const;

export const JUDGMENT_MESSAGE_KINDS = [
  "request",
  "capability_question",
  "small_talk",
  "out_of_scope",
] as const;

export const JUDGMENT_DECLINE_REASONS = [
  "refused",
  "not_a_request",
  "no_job",
  "several_jobs",
  "low_argument_confidence",
  "uncovered_value",
  "write",
  "needs_history",
  "ungrounded_value",
] as const;

export const JUDGMENT_SHADOW_TEXT_MAX = 200;
export const JUDGMENT_SHADOW_ARGS_MAX = 16;
export const JUDGMENT_SHADOW_LIST_MAX = 8;

const probability = z.number().min(0).max(1);
const shadowText = z.string().max(JUDGMENT_SHADOW_TEXT_MAX);

const shadowArgValueSchema = z.union([
  shadowText,
  z.number(),
  z.boolean(),
  z.null(),
  z.array(shadowText).max(JUDGMENT_SHADOW_LIST_MAX),
]);

const shadowArgsSchema = z
  .record(z.string().min(1).max(60), shadowArgValueSchema)
  .refine((args) => Object.keys(args).length <= JUDGMENT_SHADOW_ARGS_MAX, {
    message: "too many arguments",
  });

export const judgmentShadowCallSchema = z.strictObject({
  tool: z.string().min(1).max(100),
  args: shadowArgsSchema,
});

export const judgmentShadowSchema = z.strictObject({
  version: z.literal(2),
  model: z.string().min(1).max(64),
  latencyMs: z.number().int().nonnegative(),
  refusal: z.enum(JUDGMENT_REFUSAL_REASONS).optional(),
  kind: z.enum(JUDGMENT_MESSAGE_KINDS).optional(),
  kindConfidence: probability.optional(),
  needsHistory: probability.optional(),
  rewriteUsed: z.boolean(),
  plan: judgmentShadowCallSchema
    .extend({ risk: z.enum(["read", "write"]), minConfidence: probability })
    .optional(),
  wouldTake: z.boolean(),
  taken: z.boolean(),
  declinedBecause: z.enum(JUDGMENT_DECLINE_REASONS).optional(),
  modelFirstCall: judgmentShadowCallSchema.nullable(),
  toolAgrees: z.boolean().nullable(),
  argsAgree: z.boolean().nullable(),
});

export type JudgmentShadow = z.infer<typeof judgmentShadowSchema>;
export type JudgmentShadowCall = z.infer<typeof judgmentShadowCallSchema>;
export type JudgmentShadowArgValue = z.infer<typeof shadowArgValueSchema>;
export type JudgmentMessageKind = (typeof JUDGMENT_MESSAGE_KINDS)[number];
export type JudgmentDeclineReason = (typeof JUDGMENT_DECLINE_REASONS)[number];
