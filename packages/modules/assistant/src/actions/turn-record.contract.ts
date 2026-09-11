/**
 * The shapes shared by the turn actions (SHO-560, ADR-0039).
 *
 * A turn is addressed by what its BullMQ job carries — the conversation, the
 * accept's kind and the command — and never by a row id, so a worker and the
 * reconciler name the same turn the accept stored.
 *
 * The enums repeat `ASSISTANT_TURN_KINDS` / `ASSISTANT_TURN_STATUSES` from the
 * owned schema, because a contract file may not import `@showzy/db`. A unit test
 * pins them equal.
 */
import { ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD } from "@showzy/validation/assistant-budget";
import { z } from "zod";

export const assistantTurnKindSchema = z.enum(["chat", "answer"]);

export const assistantTurnStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "interrupted",
]);

export const assistantTurnFinalStatusSchema = z.enum([
  "done",
  "failed",
  "interrupted",
]);

/** The identity a job carries. Any casing; stored and compared lowercase. */
export const assistantTurnRefShape = {
  conversationId: z.uuid(),
  kind: assistantTurnKindSchema,
  commandId: z.uuid(),
} as const;

export const assistantTurnViewSchema = z.strictObject({
  conversationId: z.uuid(),
  kind: assistantTurnKindSchema,
  commandId: z.uuid(),
  status: assistantTurnStatusSchema,
  placeholderMessageId: z.uuid(),
  userMessageId: z.uuid().nullable(),
  continuesCommandId: z.uuid().nullable(),
});

/**
 * A budget reservation, in integer micro-USD so it is stored exactly, and the
 * Europe/Kyiv day it was reserved on.
 */
export const assistantTurnBudgetHoldSchema = z.strictObject({
  companyReservedMicroUsd: z
    .int()
    .nonnegative()
    .max(ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD),
  globalReservedMicroUsd: z
    .int()
    .nonnegative()
    .max(ASSISTANT_TURN_RESERVATION_MAX_MICRO_USD),
  kyivDate: z.iso.date(),
});

/** Longest a running turn may be given before the reconciler interrupts it. */
export const ASSISTANT_TURN_TIMEOUT_MAX_MS = 15 * 60 * 1000;
