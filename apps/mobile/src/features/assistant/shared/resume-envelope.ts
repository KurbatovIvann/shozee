/**
 * Shared HITL resume envelope (SHO-522). Duplicates `@showzy/ai` pending
 * wire schemas — mobile must not import that package.
 */
import { z } from "zod";

import {
  CHOICE_OPTIONS_MAX,
  staffAssistantChoiceCardEnvelopeSchema,
  type StaffAssistantChoiceCardEnvelope,
} from "./choice";
import {
  staffAssistantConfirmationSchema,
  type StaffAssistantConfirmation,
} from "./confirmation";

export const ASSISTANT_CONFIRM_PATH = "/assistant/confirm";
export const ASSISTANT_PENDING_PATH = "/assistant/pending";
export const ASSISTANT_PENDING_ABANDON_PATH = "/assistant/pending/abandon";

const publicPendingChoiceSchema = z.strictObject({
  kind: z.literal("choice"),
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["open", "claimed"]),
  actionName: z.string().min(1),
  envelope: staffAssistantChoiceCardEnvelopeSchema,
});

const publicPendingConfirmationApprovalSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("host"),
  }),
  z.strictObject({
    source: z.literal("core"),
    challengeId: z.uuid(),
  }),
]);

const publicPendingConfirmationSchema = z.strictObject({
  kind: z.literal("confirmation"),
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(["open", "claimed"]),
  actionName: z.string().min(1),
  challengeId: z.uuid(),
  summary: z.string().min(1),
  expiresAt: z.string().min(1),
  toolCallId: z.string().min(1),
  approval: publicPendingConfirmationApprovalSchema,
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
    envelope: staffAssistantConfirmationSchema,
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

/**
 * Card hide after abandon is only a successful host transition: `ok`,
 * or a real server `expired` (CAS miss on a mounted host). Peek
 * unavailable and HTTP `error` keep the card.
 */
export function shouldHidePendingCardAfterAbandon(
  result: "skipped" | AssistantHostInteractionResult,
): boolean {
  return (
    result !== "skipped" &&
    (result.status === "ok" || result.status === "expired")
  );
}

export const assistantPendingPeekResultSchema = z.strictObject({
  pending: publicPendingSchema.nullable(),
});

export type AssistantPendingPeekResult = z.output<
  typeof assistantPendingPeekResultSchema
>;

export type AssistantPendingHostMeta = {
  readonly id: string;
  readonly version: number;
  readonly kind: "choice" | "confirmation";
};

export type ResumeAppendPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "data-choice";
      readonly data: StaffAssistantChoiceCardEnvelope;
      readonly pendingVersion?: number;
    }
  | {
      readonly type: "data-confirmation";
      readonly data: StaffAssistantConfirmation & {
        readonly pendingVersion?: number;
      };
    }
  | {
      readonly type: "data-resumeCard";
      readonly data: unknown;
    }
  | {
      readonly type: "dynamic-tool";
      readonly toolName: "orders.create" | "orders.get";
      readonly toolCallId: string;
      readonly state: "output-available";
      readonly input: Record<string, never>;
      readonly output: {
        readonly orderId: string;
        readonly orderNumber: string;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pendingHostMetaFromPublic(
  pending: PublicPending | null,
): AssistantPendingHostMeta | null {
  if (pending === null) {
    return null;
  }
  return {
    id: pending.id,
    version: pending.version,
    kind: pending.kind,
  };
}

export function entityFromResumeCards(
  cards: readonly AssistantResumeCard[],
): { readonly orderId: string; readonly orderNumber: string } | undefined {
  for (const card of cards) {
    if (card.kind !== "surface") {
      continue;
    }
    if (!isRecord(card.data)) {
      continue;
    }
    const orderId = card.data.orderId;
    const orderNumber = card.data.orderNumber;
    if (typeof orderId !== "string" || typeof orderNumber !== "string") {
      continue;
    }
    if (orderId.length === 0 || orderNumber.length === 0) {
      continue;
    }
    return { orderId, orderNumber };
  }
  return undefined;
}

export function partsFromResumeEnvelope(
  envelope: AssistantResumeEnvelope,
): readonly ResumeAppendPart[] {
  const parts: ResumeAppendPart[] = [];
  if (envelope.speech.length > 0) {
    parts.push({ type: "text", text: envelope.speech });
  }
  let surfaceIndex = 0;
  const pending = envelope.pending;
  for (const card of envelope.cards) {
    if (card.kind === "choice") {
      const pendingVersion =
        pending?.kind === "choice" && pending.id === card.envelope.challengeId
          ? pending.version
          : undefined;
      parts.push({
        type: "data-choice",
        data: card.envelope,
        ...(pendingVersion === undefined ? {} : { pendingVersion }),
      });
      continue;
    }
    if (card.kind === "confirmation") {
      const pendingVersion =
        pending?.kind === "confirmation" &&
        pending.challengeId === card.envelope.challengeId
          ? pending.version
          : undefined;
      parts.push({
        type: "data-confirmation",
        data: {
          ...card.envelope,
          ...(pendingVersion === undefined ? {} : { pendingVersion }),
        },
      });
      continue;
    }
    parts.push({ type: "data-resumeCard", data: card.data });
    const entity = entityFromResumeCards([card]);
    if (entity !== undefined) {
      parts.push({
        type: "dynamic-tool",
        toolName: "orders.create",
        toolCallId: `resume-surface:${String(surfaceIndex)}`,
        state: "output-available",
        input: {},
        output: entity,
      });
    }
    surfaceIndex += 1;
  }
  return parts;
}

export function confirmationFromPublicPending(
  pending: Extract<PublicPending, { kind: "confirmation" }>,
): StaffAssistantConfirmation {
  return {
    status: "confirmation_required",
    challengeId: pending.challengeId,
    summary: pending.summary,
    expiresAt: pending.expiresAt,
    actionName: pending.actionName,
    toolCallId: pending.toolCallId,
  };
}

export function choiceEnvelopeFromPublicPending(
  pending: Extract<PublicPending, { kind: "choice" }>,
): StaffAssistantChoiceCardEnvelope {
  return pending.envelope;
}

export const CHOICE_CARD_OPTIONS_MAX = CHOICE_OPTIONS_MAX;
