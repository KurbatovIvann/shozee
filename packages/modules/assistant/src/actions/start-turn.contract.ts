import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import {
  ASSISTANT_TURN_TIMEOUT_MAX_MS,
  assistantTurnRefShape,
  assistantTurnStatusSchema,
} from "./turn-record.contract.js";

export const startTurnInputSchema = z.strictObject({
  ...assistantTurnRefShape,
  timeoutMs: z.int().min(1_000).max(ASSISTANT_TURN_TIMEOUT_MAX_MS),
});

export const startTurnOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("started"),
    conversationId: z.uuid(),
    deadlineAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    outcome: z.literal("not_queued"),
    conversationId: z.uuid(),
    status: assistantTurnStatusSchema,
  }),
  z.strictObject({
    outcome: z.literal("expired"),
    conversationId: z.uuid(),
  }),
]);

export const startTurnContract = defineActionContract({
  name: "assistant.startTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Start an accepted turn, named by its conversation, kind and command: a queued turn becomes running with a deadline of timeoutMs from now. A queued turn whose start deadline has passed is refused as expired and left queued for its job's exhaustion to end. A turn that is no longer queued is left as it is and its status returned as not_queued. A turn that does not exist, or a conversation belonging to another author or another company, is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: startTurnInputSchema,
  output: startTurnOutputSchema,
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
