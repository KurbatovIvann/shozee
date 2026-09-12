import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const readActiveTurnInputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const readActiveTurnOutputSchema = z.strictObject({
  turn: z
    .strictObject({
      id: z.uuid(),
      status: z.enum(["queued", "running"]),
    })
    .nullable(),
});

export const readActiveTurnContract = defineActionContract({
  name: "assistant.readActiveTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Read the conversation's active turn, if one holds it — the same lease an accept claims and a finish releases, read from the list ASSISTANT_TURN_ACTIVE_STATUSES names. A conversation with no active turn reads as null, not as not-found; a conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: readActiveTurnInputSchema,
  output: readActiveTurnOutputSchema,
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
