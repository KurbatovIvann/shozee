/**
 * Staff write: replace the stored payload of one message.
 *
 * Addressed by sequence number **and** message id together, so an update can
 * only land on the message the runtime just read as the latest. Either one
 * alone would let a stale caller overwrite a message it never saw.
 *
 * Mechanical: `timeout: 5000` is one update by unique key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  chatMessagePayloadSchema,
  chatMessageSeqSchema,
} from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const updateChatMessageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
  messageId: z.uuid(),
  message: chatMessagePayloadSchema,
});

export const updateChatMessageOutputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
});

export const updateChatMessageContract = defineActionContract({
  name: "assistant.updateChatMessage",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Replace the stored payload of one message, named by its sequence number and its message id together. The payload is opaque and owned by the assistant runtime. A pair that names no stored message is not-found, as is a conversation belonging to another author or another company. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: updateChatMessageInputSchema,
  output: updateChatMessageOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  /**
   * Not keyed. Writing the same payload again stores the same bytes; a later
   * payload is the live message moving on, which a replay would lose.
   */
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
