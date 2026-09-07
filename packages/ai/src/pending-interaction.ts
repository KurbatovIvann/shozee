/**
 * Pending-interaction protocol (ADR-0035 / SHO-516). Confirmation and
 * choice share one record discriminated by `kind`. Resume is HTTP, not a
 * model call. Canonical input is server-authoritative and must not be
 * logged at info.
 */
import { z } from "zod";

import {
  CHOICE_TTL_MS,
  choiceRecordSchema,
  type ChoiceBind,
  type ChoiceRecord,
} from "./choice.js";
import { staffAssistantLocaleSchema } from "./locale.js";

export const PENDING_INTERACTION_KINDS = ["confirmation", "choice"] as const;

export type PendingInteractionKind = (typeof PENDING_INTERACTION_KINDS)[number];

export const pendingInteractionKindSchema = z.enum(PENDING_INTERACTION_KINDS);

export const pendingInteractionStatusSchema = z.enum([
  "open",
  "claimed",
  "completed",
]);

export type PendingInteractionStatus = z.output<
  typeof pendingInteractionStatusSchema
>;

/**
 * Redis key prefix. Choice used `choice:{id}`; those keys expire unused.
 * Confirmation TTL is core's 5 minutes plus a short grace so the API can
 * answer `expired` instead of treating a just-expired core challenge as
 * missing. Do not import core — keep this package independent of that
 * constant (same reason as `CHOICE_TTL_MS`).
 */
export const PENDING_REDIS_KEY_PREFIX = "pending:" as const;

/** Matches core `CONFIRMATION_TTL_MS` without importing `@showzy/core`. */
export const CONFIRMATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Extra Redis TTL so API can distinguish expired vs missing. */
export const CONFIRMATION_RECORD_GRACE_MS = 30 * 1000;

export const CONFIRMATION_RECORD_TTL_MS =
  CONFIRMATION_CHALLENGE_TTL_MS + CONFIRMATION_RECORD_GRACE_MS;

export function pendingRedisKey(
  kind: PendingInteractionKind,
  id: string,
): string {
  return `${PENDING_REDIS_KEY_PREFIX}${kind}:${id}`;
}

export function pendingRecordTtlMs(kind: PendingInteractionKind): number {
  return kind === "confirmation" ? CONFIRMATION_RECORD_TTL_MS : CHOICE_TTL_MS;
}

export const confirmationResumeCompletedSchema = z.strictObject({
  status: z.literal("completed"),
  text: z.string().min(1),
  actionName: z.string().min(1),
  toolCallId: z.string().min(1),
  output: z.unknown().optional(),
  presentation: z.unknown().optional(),
});

export const confirmationResumeErrorSchema = z.strictObject({
  status: z.literal("error"),
  text: z.string().min(1),
  code: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});

export const confirmationResumeExpiredSchema = z.strictObject({
  status: z.literal("expired"),
  text: z.string().min(1).optional(),
});

export const confirmationResumeResultSchema = z.discriminatedUnion("status", [
  confirmationResumeCompletedSchema,
  confirmationResumeErrorSchema,
  confirmationResumeExpiredSchema,
]);

export type ConfirmationResumeResult = z.output<
  typeof confirmationResumeResultSchema
>;

export const confirmationPendingRecordSchema = z.strictObject({
  kind: z.literal("confirmation"),
  id: z.uuid(),
  status: pendingInteractionStatusSchema,
  actorId: z.string().min(1),
  companyId: z.uuid(),
  conversationId: z.uuid(),
  actionName: z.string().min(1),
  toolCallId: z.string().min(1),
  canonicalInput: z.unknown(),
  locale: staffAssistantLocaleSchema,
  expiresAt: z.string().min(1),
  claimedResolution: z.literal("confirmed").optional(),
  resumeResult: confirmationResumeResultSchema.optional(),
});

export type ConfirmationPendingRecord = z.output<
  typeof confirmationPendingRecordSchema
>;

/**
 * Choice variant of the pending record. Extra protocol fields are
 * optional so existing `ChoiceRecord` fixtures still parse; writers
 * always set them.
 */
export const choicePendingRecordSchema = choiceRecordSchema.extend({
  kind: z.literal("choice").optional(),
  id: z.uuid().optional(),
  actionName: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
});

export type ChoicePendingRecord = z.output<typeof choicePendingRecordSchema>;

export const pendingInteractionRecordSchema = z.union([
  confirmationPendingRecordSchema,
  choicePendingRecordSchema,
]);

export type PendingInteractionRecord = z.output<
  typeof pendingInteractionRecordSchema
>;

export const assistantConfirmBodySchema = z.strictObject({
  conversationId: z.uuid(),
  challengeId: z.uuid(),
});

export type AssistantConfirmBody = z.output<typeof assistantConfirmBodySchema>;

export const assistantConfirmInteractionResultSchema = z.discriminatedUnion(
  "status",
  [
    confirmationResumeCompletedSchema,
    z.strictObject({
      status: z.literal("expired"),
    }),
    z.strictObject({
      status: z.literal("error"),
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ],
);

export type AssistantConfirmInteractionResult = z.output<
  typeof assistantConfirmInteractionResultSchema
>;

export function pendingKindOf(
  record: PendingInteractionRecord,
): PendingInteractionKind {
  if (record.kind === "confirmation") {
    return "confirmation";
  }
  return "choice";
}

export function pendingIdOf(record: PendingInteractionRecord): string {
  if (record.kind === "confirmation") {
    return record.id;
  }
  return record.choiceId;
}

export function pendingBindOf(record: PendingInteractionRecord): ChoiceBind {
  return {
    actorId: record.actorId,
    companyId: record.companyId,
    conversationId: record.conversationId,
  };
}

export function pendingClaimedResolutionOf(
  record: PendingInteractionRecord,
): string | undefined {
  if (record.kind === "confirmation") {
    return record.claimedResolution;
  }
  return record.claimedOptionId;
}

export function choiceRecordToPending(
  record: ChoiceRecord,
): ChoicePendingRecord {
  const expiresAt =
    record.expiresAt ?? new Date(Date.now() + CHOICE_TTL_MS).toISOString();
  return choicePendingRecordSchema.parse({
    ...record,
    kind: "choice",
    id: record.id ?? record.choiceId,
    actionName: record.actionName ?? "orders.create",
    toolCallId: record.toolCallId ?? `choice:${record.choiceId}`,
    expiresAt,
  });
}

export function pendingToChoiceRecord(
  record: ChoicePendingRecord,
): ChoiceRecord {
  return choiceRecordSchema.parse({
    status: record.status,
    choiceId: record.choiceId,
    actorId: record.actorId,
    companyId: record.companyId,
    conversationId: record.conversationId,
    canonicalInput: record.canonicalInput,
    target: record.target,
    optionMap: record.optionMap,
    envelope: record.envelope,
    ...(record.locale !== undefined ? { locale: record.locale } : {}),
    ...(record.claimedOptionId !== undefined
      ? { claimedOptionId: record.claimedOptionId }
      : {}),
    kind: "choice",
    id: record.id ?? record.choiceId,
    actionName: record.actionName ?? "orders.create",
    toolCallId: record.toolCallId ?? `choice:${record.choiceId}`,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
  });
}

export function confirmationPendingRecordFromPause(args: {
  readonly challengeId: string;
  readonly bind: ChoiceBind;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly canonicalInput: unknown;
  readonly locale: "uk" | "en";
  readonly expiresAt: string;
}): ConfirmationPendingRecord {
  return confirmationPendingRecordSchema.parse({
    kind: "confirmation",
    id: args.challengeId,
    status: "open",
    actorId: args.bind.actorId,
    companyId: args.bind.companyId,
    conversationId: args.bind.conversationId,
    actionName: args.actionName,
    toolCallId: args.toolCallId,
    canonicalInput: args.canonicalInput,
    locale: args.locale,
    expiresAt: args.expiresAt,
  });
}

export function parsePendingInteractionRecord(
  raw: string,
): PendingInteractionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const confirmation = confirmationPendingRecordSchema.safeParse(parsed);
  if (confirmation.success) {
    return confirmation.data;
  }
  const choice = choicePendingRecordSchema.safeParse(parsed);
  return choice.success ? choice.data : undefined;
}

export function serializePendingInteractionRecord(
  record: PendingInteractionRecord,
): string {
  if (record.kind === "confirmation") {
    return JSON.stringify(confirmationPendingRecordSchema.parse(record));
  }
  return JSON.stringify(choicePendingRecordSchema.parse(record));
}
