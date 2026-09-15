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
  chatMessageRevisionSchema,
  chatMessageSeqSchema,
} from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";
import { assistantTurnClaimSchema } from "./turn-record.contract.js";

export const updateChatMessageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
  messageId: z.uuid(),
  /** The revision the caller read; the update lands only while it still holds. */
  revision: chatMessageRevisionSchema,
  message: chatMessagePayloadSchema,
  claim: assistantTurnClaimSchema.optional(),
});

export const updateChatMessageOutputSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("updated"),
    conversationId: z.uuid(),
    seq: chatMessageSeqSchema,
    revision: chatMessageRevisionSchema,
  }),
  z.strictObject({
    outcome: z.literal("stale"),
    conversationId: z.uuid(),
    seq: chatMessageSeqSchema,
  }),
]);

export const updateChatMessageContract = defineActionContract({
  name: "assistant.updateChatMessage",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Replace the stored payload of one message, named by its sequence number and its message id together, and raise its revision by one, only while the message still has the revision the caller read; otherwise nothing is stored and the outcome is stale, so the caller reads the message again. With a claim (kind and command id), the update is stored only while that turn of this conversation is running, and is a conflict otherwise, the only conflict this action raises; the check locks the turn row, so it serialises with the turn's end. The payload is opaque and owned by the assistant runtime. A pair that names no stored message is not-found, as is a conversation belonging to another author or another company. Company id is never input.`,
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
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
