/**
 * Staff write: replace the stored payload of one message.
 *
 * Addressed by sequence number **and** message id together, so an update can
 * only land on the message the runtime just read as the latest. Either one
 * alone would let a stale caller overwrite a message it never saw.
 *
 * A compare-and-set on `revision`, the one the caller read (SHO-570). A turn's
 * message has two writers — the worker running it and the reconciler ending it
 * — and each stores a whole new payload, so an update from a revision the
 * message no longer has is refused as `CONFLICT` and stores nothing. The caller
 * reads the message again and applies its change to what is stored.
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

export const updateChatMessageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
  messageId: z.uuid(),
  /** The revision the caller read; the update lands only while it still holds. */
  revision: chatMessageRevisionSchema,
  message: chatMessagePayloadSchema,
});

export const updateChatMessageOutputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
  /** The message's revision after this write: one more than before it. */
  revision: chatMessageRevisionSchema,
});

export const updateChatMessageContract = defineActionContract({
  name: "assistant.updateChatMessage",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Replace the stored payload of one message, named by its sequence number and its message id together, and raise its revision by one, only while the message still has the revision the caller read; otherwise nothing is stored and it is a conflict. The payload is opaque and owned by the assistant runtime. A pair that names no stored message is not-found, as is a conversation belonging to another author or another company. Company id is never input.`,
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
