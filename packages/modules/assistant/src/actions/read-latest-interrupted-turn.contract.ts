import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import { assistantTurnEndReasonSchema } from "./turn-record.contract.js";

export const readLatestInterruptedTurnInputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const readLatestInterruptedTurnOutputSchema = z.strictObject({
  commandId: z.uuid().nullable(),
  messageId: z.uuid().nullable(),
  endReason: assistantTurnEndReasonSchema.nullable(),
});

export const readLatestInterruptedTurnContract = defineActionContract({
  name: "assistant.readLatestInterruptedTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Read the commandId of the most recently interrupted turn of this conversation — Продовжити resolves which turn to continue from this, never from a client-supplied id. Its messageId is that turn's own placeholder message, so a client places the interruption on the reply it belongs to rather than on the latest one. Its endReason is the stored cause (not_started, job_exhausted or timeout), null for an ordinary interruption. All are null when no turn of this conversation is interrupted. A conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: readLatestInterruptedTurnInputSchema,
  output: readLatestInterruptedTurnOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
