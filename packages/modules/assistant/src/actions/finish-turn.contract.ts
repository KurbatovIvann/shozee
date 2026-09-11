/**
 * Staff write: record how a turn ended, and free its conversation (SHO-560).
 *
 * Compare-and-set from an active status to a final one. A turn that has
 * already ended keeps the status it ended with — a late `done` from a worker
 * cannot overwrite the reconciler's `interrupted` — and reports it as
 * `already_finished`.
 *
 * Mechanical: `timeout: 5000` is one update by unique key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  assistantTurnFinalStatusSchema,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const finishTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
  status: assistantTurnFinalStatusSchema,
});

export const finishTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("finished"),
    conversationId: z.uuid(),
    status: assistantTurnFinalStatusSchema,
  }),
  z.strictObject({
    outcome: z.literal("already_finished"),
    conversationId: z.uuid(),
    status: assistantTurnStatusSchema,
  }),
]);

export const finishTurnContract = defineActionContract({
  name: "assistant.finishTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Finish a turn, named by its conversation, kind and command, as done, failed or interrupted. A queued or running turn takes that status and stops holding its conversation, so the next turn can be accepted. A turn that already ended keeps its status and reports it as already_finished. A turn that does not exist, or a conversation belonging to another author or another company, is not-found. Company id is never input.`,
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
