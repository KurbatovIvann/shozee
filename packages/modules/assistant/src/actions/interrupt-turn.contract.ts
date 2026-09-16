import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  assistantTurnActiveStatusSchema,
  assistantTurnBudgetHoldSchema,
  assistantTurnEndReasonSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const interruptTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
});

export const interruptTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("interrupted"),
    conversationId: z.uuid(),
    /** The status this call ended the turn from. */
    from: assistantTurnActiveStatusSchema,
    endReason: assistantTurnEndReasonSchema,
    releasedHold: assistantTurnBudgetHoldSchema,
  }),
  z.strictObject({
    outcome: z.literal("already_finished"),
    conversationId: z.uuid(),
    status: assistantTurnStatusSchema,
  }),
]);

export const interruptTurnContract = defineActionContract({
  name: "assistant.interruptTurn",
  description:
    "End a staff assistant turn of this company whose job is exhausted, named by its conversation, kind and command. A turn still queued or running becomes interrupted whether or not any deadline elapsed, with end reason not_started when it never started and job_exhausted when it was running; it stops holding its conversation and gives up the budget hold it stored, which is returned with the status it was ended from. A turn that already ended keeps its status, reports it as already_finished and returns no hold. A turn that does not exist in this company is not-found. Company id is never input.",
  principal: "system",
  systemScope: "tenant",
  transport: "internal",
  input: interruptTurnInputSchema,
  output: interruptTurnOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
