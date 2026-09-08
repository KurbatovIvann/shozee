/**
 * Staff conversation get (SHO-321 / feature SHO-318). Mechanical:
 * `timeout: 5000` is one author-owned conversation plus its messages and
 * tool-run refs. Missing, foreign-author, and foreign-company ids fail
 * with the same not-found. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  conversationViewSchema,
  messageViewSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  toolRunViewSchema,
} from "./conversation-view.contract.js";

/**
 * Mechanical (SHO-506): optional page of newest messages. Omitted keeps
 * the previous unbounded read. Max 200.
 */
export const GET_CONVERSATION_MESSAGES_MAX = 200;

export const getConversationInputSchema = z.strictObject({
  conversationId: z.uuid(),
  limit: z.number().int().min(1).max(GET_CONVERSATION_MESSAGES_MAX).optional(),
});

export const getConversationOutputSchema = conversationViewSchema.extend({
  messages: z.array(messageViewSchema),
  toolRuns: z.array(toolRunViewSchema),
});

export const getConversationContract = defineActionContract({
  name: "assistant.getConversation",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Return one conversation the caller authored, including messages and tool-run refs (action name, toolCallId, challengeId, result ids, outcome). challengeId is the opaque interaction id for confirmation or choice; outcome may be success, error, confirmation_required, or choice_required. Open-turn empty-body assistant messages and started tool runs are omitted. Never returns tool_input or model_trace. Optional limit returns the newest messages (max 200); omitted keeps the unbounded read. Company id is never input. Tool-run rows store ids and outcome only — never order or document status.`,
  principal: "staff",
  transport: "client",
  input: getConversationInputSchema,
  output: getConversationOutputSchema,
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
