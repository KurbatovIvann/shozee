/**
 * Shared pending-interaction record (ADR-0035 store, ADR-0037 resume).
 *
 * Redis lives in `apps/api`. This package owns the schema, public view,
 * and resume envelope. Canonical input never appears on the wire.
 */
import { z } from "zod";

import {
  choiceBindSchema,
  choiceCanonicalCreateInputSchema,
  choiceCardEnvelope,
  choiceRecordSchema,
  choiceTargetSchema,
  CHOICE_TTL_MS,
  staffAssistantChoiceCardEnvelopeSchema,
  successorChoiceId,
  type ChoiceBind,
  type ChoiceRecord,
} from "./choice.js";
import { staffAssistantConfirmationOutputSchema } from "./confirmation.js";
import { STAFF_ASSISTANT_DEFAULT_LOCALE } from "./locale.js";

export const PENDING_REDIS_KEY_PREFIX = "pending:" as const;
export const PENDING_CONVERSATION_INDEX_PREFIX =
  "pending:conversation:" as const;

/**
 * Confirmation record TTL: core's 5 minutes plus a short grace so the
 * api can answer expired instead of missing. Do not import core.
 */
export const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000 + 15_000;

export const PENDING_KINDS = ["choice", "confirmation"] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export const PENDING_STATUSES = [
  "open",
  "claimed",
  "completed",
  "superseded",
  "abandoned",
] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export const pendingKindSchema = z.enum(PENDING_KINDS);
export const pendingStatusSchema = z.enum(PENDING_STATUSES);
export const pendingBindSchema = choiceBindSchema;
export type PendingBind = ChoiceBind;

export const PENDING_OPEN_CODE = "PENDING_OPEN" as const;
export const PENDING_REPLACE_TOOL_NAME = "pending_replace" as const;

export const PENDING_OPEN_REFUSE_COPY = {
  en: "Finish, abandon, or replace the current pending action first.",
  uk: "Спочатку заверши, скасуй або заміни поточну незавершену дію.",
} as const;

export function pendingTtlMs(kind: PendingKind): number {
  return kind === "confirmation" ? PENDING_CONFIRMATION_TTL_MS : CHOICE_TTL_MS;
}

export function conversationPendingIndexPayload(record: {
  readonly kind: PendingKind;
  readonly id: string;
}): string {
  return JSON.stringify({ kind: record.kind, id: record.id });
}

export function parseConversationPendingIndex(
  raw: string,
): { readonly kind: PendingKind; readonly id: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    !("id" in parsed)
  ) {
    return undefined;
  }
  const kind = pendingKindSchema.safeParse(parsed.kind);
  const id = z.uuid().safeParse(parsed.id);
  if (!kind.success || !id.success) {
    return undefined;
  }
  return { kind: kind.data, id: id.data };
}

export function pendingConversationIndexKey(conversationId: string): string {
  return `${PENDING_CONVERSATION_INDEX_PREFIX}${conversationId}`;
}

export function pendingRedisKey(kind: PendingKind, id: string): string {
  return `${PENDING_REDIS_KEY_PREFIX}${kind}:${id}`;
}

const pendingCommonFields = {
  version: z.number().int().positive(),
  status: pendingStatusSchema,
  actorId: z.string().min(1),
  companyId: z.uuid(),
  conversationId: z.uuid(),
  actionName: z.string().min(1),
  toolCallId: z.string().min(1),
  locale: z.enum(["uk", "en"]).optional(),
  executionId: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
};

export const pendingChoiceRecordSchema = z.strictObject({
  kind: z.literal("choice"),
  id: z.uuid(),
  ...pendingCommonFields,
  canonicalInput: choiceCanonicalCreateInputSchema,
  target: choiceTargetSchema,
  optionMap: z.record(z.uuid(), z.uuid()),
  envelope: staffAssistantChoiceCardEnvelopeSchema,
  claimedOptionId: z.uuid().optional(),
});

export type PendingChoiceRecord = z.output<typeof pendingChoiceRecordSchema>;

export const pendingConfirmationRecordSchema = z.strictObject({
  kind: z.literal("confirmation"),
  id: z.uuid(),
  ...pendingCommonFields,
  canonicalInput: z.unknown(),
  summary: z.string().min(1),
  challengeExpiresAt: z.string().min(1),
});

export type PendingConfirmationRecord = z.output<
  typeof pendingConfirmationRecordSchema
>;

export const pendingInteractionRecordSchema = z.discriminatedUnion("kind", [
  pendingChoiceRecordSchema,
  pendingConfirmationRecordSchema,
]);

export type PendingInteractionRecord = z.output<
  typeof pendingInteractionRecordSchema
>;

export const publicPendingChoiceSchema = z.strictObject({
  kind: z.literal("choice"),
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["open", "claimed"]),
  actionName: z.string().min(1),
  envelope: staffAssistantChoiceCardEnvelopeSchema,
});

export const publicPendingConfirmationSchema = z.strictObject({
  kind: z.literal("confirmation"),
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["open", "claimed"]),
  actionName: z.string().min(1),
  challengeId: z.uuid(),
  summary: z.string().min(1),
  expiresAt: z.string().min(1),
  toolCallId: z.string().min(1),
});

export const publicPendingSchema = z.discriminatedUnion("kind", [
  publicPendingChoiceSchema,
  publicPendingConfirmationSchema,
]);

export type PublicPending = z.output<typeof publicPendingSchema>;

export const assistantResumeCardSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("surface"),
    surface: z.string().min(1),
    data: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("choice"),
    envelope: staffAssistantChoiceCardEnvelopeSchema,
  }),
  z.strictObject({
    kind: z.literal("confirmation"),
    envelope: staffAssistantConfirmationOutputSchema,
  }),
]);

export type AssistantResumeCard = z.output<typeof assistantResumeCardSchema>;

export const assistantResumeEnvelopeSchema = z.strictObject({
  speech: z.string(),
  cards: z.array(assistantResumeCardSchema),
  pending: publicPendingSchema.nullable(),
});

export type AssistantResumeEnvelope = z.output<
  typeof assistantResumeEnvelopeSchema
>;

export const assistantConfirmBodySchema = z.strictObject({
  conversationId: z.uuid(),
  challengeId: z.uuid(),
});

export type AssistantConfirmBody = z.output<typeof assistantConfirmBodySchema>;

export const assistantAbandonBodySchema = z.strictObject({
  conversationId: z.uuid(),
  pendingId: z.uuid(),
  expectedVersion: z.number().int().positive(),
});

export type AssistantAbandonBody = z.output<typeof assistantAbandonBodySchema>;

export const assistantPendingPeekQuerySchema = z.strictObject({
  conversationId: z.uuid(),
});

export const assistantHostChatBodySchema = z.strictObject({
  conversationId: z.uuid(),
  text: z.string().min(1).max(16_000),
  locale: z.enum(["uk", "en"]).optional(),
});

export type AssistantHostChatBody = z.output<
  typeof assistantHostChatBodySchema
>;

export const assistantPendingPeekResultSchema = z.strictObject({
  pending: publicPendingSchema.nullable(),
});

export type AssistantPendingPeekResult = z.output<
  typeof assistantPendingPeekResultSchema
>;

export const assistantHostInteractionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("ok"),
      speech: z.string(),
      cards: z.array(assistantResumeCardSchema),
      pending: publicPendingSchema.nullable(),
    }),
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

export type AssistantHostInteractionResult = z.output<
  typeof assistantHostInteractionResultSchema
>;

export function resumeEnvelopeFromOk(
  result: Extract<AssistantHostInteractionResult, { status: "ok" }>,
): AssistantResumeEnvelope {
  return {
    speech: result.speech,
    cards: result.cards,
    pending: result.pending,
  };
}

export function parsePendingRecord(
  raw: string,
): PendingInteractionRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const result = pendingInteractionRecordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function serializePendingRecord(
  record: PendingInteractionRecord,
): string {
  return JSON.stringify(pendingInteractionRecordSchema.parse(record));
}

export function pendingRecordBind(
  record: PendingInteractionRecord,
): PendingBind {
  return {
    actorId: record.actorId,
    companyId: record.companyId,
    conversationId: record.conversationId,
  };
}

export function publicPendingFromRecord(
  record: PendingInteractionRecord,
): PublicPending | undefined {
  if (record.status !== "open" && record.status !== "claimed") {
    return undefined;
  }
  if (record.kind === "choice") {
    return publicPendingChoiceSchema.parse({
      kind: "choice",
      id: record.id,
      version: record.version,
      status: record.status,
      actionName: record.actionName,
      envelope: choiceCardEnvelope({
        challengeId: record.id,
        status: record.status === "open" ? "needs_choice" : "claimed",
        ...(record.envelope.reason !== undefined
          ? { reason: record.envelope.reason }
          : {}),
        ...(record.envelope.choiceKind !== undefined
          ? { choiceKind: record.envelope.choiceKind }
          : {}),
        ...(record.envelope.productName !== undefined
          ? { productName: record.envelope.productName }
          : {}),
        options: record.envelope.options,
        optionsTruncated: record.envelope.optionsTruncated,
        ...(record.status === "claimed" && record.claimedOptionId !== undefined
          ? { claimedOptionId: record.claimedOptionId }
          : {}),
      }),
    });
  }
  return publicPendingConfirmationSchema.parse({
    kind: "confirmation",
    id: record.id,
    version: record.version,
    status: record.status,
    actionName: record.actionName,
    challengeId: record.id,
    summary: record.summary,
    expiresAt: record.challengeExpiresAt,
    toolCallId: record.toolCallId,
  });
}

export function pendingChoiceRecordFromChoiceRecord(
  record: ChoiceRecord,
  extras: {
    readonly actionName: string;
    readonly toolCallId: string;
    readonly version?: number;
    readonly executionId?: string;
  },
): PendingChoiceRecord {
  return pendingChoiceRecordSchema.parse({
    kind: "choice",
    id: record.choiceId,
    version: extras.version ?? 1,
    status: record.status === "open" ? "open" : record.status,
    actorId: record.actorId,
    companyId: record.companyId,
    conversationId: record.conversationId,
    actionName: extras.actionName,
    toolCallId: extras.toolCallId,
    canonicalInput: record.canonicalInput,
    target: record.target,
    optionMap: record.optionMap,
    envelope: record.envelope,
    ...(record.locale !== undefined ? { locale: record.locale } : {}),
    ...(extras.executionId !== undefined
      ? { executionId: extras.executionId }
      : {}),
    ...(record.claimedOptionId !== undefined
      ? { claimedOptionId: record.claimedOptionId }
      : {}),
  });
}

export function choiceRecordFromPendingChoice(
  record: PendingChoiceRecord,
): ChoiceRecord {
  return choiceRecordSchema.parse({
    status:
      record.status === "open" ||
      record.status === "claimed" ||
      record.status === "completed"
        ? record.status
        : "open",
    choiceId: record.id,
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
  });
}

export function successorPendingChoiceId(parentId: string): string {
  return successorChoiceId(parentId);
}

export function pendingOpenRefuseOutput(locale: "uk" | "en" | undefined): {
  readonly status: "error";
  readonly code: typeof PENDING_OPEN_CODE;
  readonly message: string;
} {
  const resolved = locale ?? STAFF_ASSISTANT_DEFAULT_LOCALE;
  return {
    status: "error",
    code: PENDING_OPEN_CODE,
    message: PENDING_OPEN_REFUSE_COPY[resolved],
  };
}

export function confirmationPendingRecord(input: {
  readonly challengeId: string;
  readonly bind: PendingBind;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly canonicalInput: unknown;
  readonly summary: string;
  readonly challengeExpiresAt: string;
  readonly executionId?: string;
  readonly locale?: "uk" | "en";
  readonly version?: number;
}): PendingConfirmationRecord {
  return pendingConfirmationRecordSchema.parse({
    kind: "confirmation",
    id: input.challengeId,
    version: input.version ?? 1,
    status: "open",
    actorId: input.bind.actorId,
    companyId: input.bind.companyId,
    conversationId: input.bind.conversationId,
    actionName: input.actionName,
    toolCallId: input.toolCallId,
    canonicalInput: input.canonicalInput,
    summary: input.summary,
    challengeExpiresAt: input.challengeExpiresAt,
    ...(input.executionId !== undefined
      ? { executionId: input.executionId }
      : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  });
}
