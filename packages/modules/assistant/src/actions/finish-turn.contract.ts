import { defineActionContract } from "@showzy/core/contract";
import { judgmentShadowSchema } from "@showzy/validation/assistant-judgment";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  assistantTurnBudgetHoldSchema,
  assistantTurnFinalStatusSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const finishTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
  status: assistantTurnFinalStatusSchema,
  judgmentShadow: judgmentShadowSchema.optional(),
});

export const finishTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("finished"),
    conversationId: z.uuid(),
    status: assistantTurnFinalStatusSchema,
    releasedHold: assistantTurnBudgetHoldSchema,
  }),
  z.strictObject({
    outcome: z.literal("already_finished"),
    conversationId: z.uuid(),
    status: assistantTurnStatusSchema,
  }),
]);

export const finishTurnContract = defineActionContract({
  name: "assistant.finishTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Finish a turn, named by its conversation, kind and command, as done, failed or interrupted. A queued or running turn takes that status, stops holding its conversation so the next turn can be accepted, and gives up the budget hold it stored, which is returned. An optional judgment shadow (ADR-0044: what a typed judgment would have planned beside what the language model did first) is stored on the turn in the same write and changes nothing else. A turn that already ended keeps its status and reports it as already_finished with no hold, and stores no shadow. A turn that does not exist, or a conversation belonging to another author or another company, is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: finishTurnInputSchema,
  output: finishTurnOutputSchema,
  permissions: ["assistant:use"],
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
