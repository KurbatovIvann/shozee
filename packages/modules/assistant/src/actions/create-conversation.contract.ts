/**
 * Staff write: create a conversation for the calling staff user.
 * Mechanical: `timeout: 5000` is one insert. Optional title is trimmed
 * and capped at 200. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  conversationTitleSchema,
  conversationViewSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";

export const createConversationInputSchema = z.strictObject({
  title: conversationTitleSchema.optional(),
});

export const createConversationOutputSchema = conversationViewSchema;

export const createConversationContract = defineActionContract({
  name: "assistant.createConversation",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Create a conversation for the calling staff user. Optional title is stored on the row. Company id is never input; tenant scope comes from the verified membership. Re-submitting the identical payload with the same idempotency key returns the already-created conversation and does not insert duplicates.`,
  principal: "staff",
  transport: "client",
  input: createConversationInputSchema,
  output: createConversationOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: true,
  timeout: 5_000,
});
