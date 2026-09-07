/**
 * Staff write: append a user message. The handler forces role `user`;
 * role is never input. Mechanical: `timeout: 5000` is one insert plus a
 * conversation touch. Body is capped at 16_000. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  messageBodySchema,
  messageViewSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";

export const appendUserMessageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  body: messageBodySchema,
});

export const appendUserMessageOutputSchema = messageViewSchema;

export const appendUserMessageContract = defineActionContract({
  name: "assistant.appendUserMessage",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Append a user message to a conversation the caller authored. The stored role is always user; clients cannot supply a role. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-appended message and does not insert duplicates.`,
  principal: "staff",
  transport: "client",
  input: appendUserMessageInputSchema,
  output: appendUserMessageOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
