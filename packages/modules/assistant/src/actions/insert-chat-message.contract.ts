/**
 * Staff write: add a message to the end of a conversation's log.
 *
 * The sequence number is assigned here, one past the last. An insert that
 * repeats a message id already in the conversation is refused rather than
 * turned into an update: the only message a runtime may change is the latest,
 * and it does that through `updateChatMessage` by naming it exactly. A second
 * insert racing for the same sequence number is refused the same way — the
 * runtime holds a lease per conversation, and this is what makes a lease that
 * failed loud instead of silent.
 *
 * Mechanical: `timeout: 5000` is one insert with a max over one index range.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  chatMessageBindSchema,
  chatMessagePayloadSchema,
  chatMessageSeqSchema,
} from "./chat-message-record.contract.js";
import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const insertChatMessageInputSchema = z.strictObject({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  bind: chatMessageBindSchema,
  message: chatMessagePayloadSchema,
});

export const insertChatMessageOutputSchema = z.strictObject({
  conversationId: z.uuid(),
  seq: chatMessageSeqSchema,
});

export const insertChatMessageContract = defineActionContract({
  name: "assistant.insertChatMessage",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Append one message to a conversation's stored log and return the sequence number it was given. The message is an opaque payload owned by the assistant runtime. A message id the conversation already holds is a conflict, never an update; so is a concurrent insert that took the same sequence number. A conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: insertChatMessageInputSchema,
  output: insertChatMessageOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  /**
   * Not keyed. The message id already is the attempt's identity, and the
   * database refuses it a second time — a replay store would only turn that
   * refusal into a quiet success.
   */
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 5_000,
});
