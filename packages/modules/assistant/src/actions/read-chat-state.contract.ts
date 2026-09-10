/**
 * Staff read: the durable half of an `assistant-kit` conversation.
 *
 * Two opaque blobs — the chat document a person reads, and the provider
 * messages the next turn is built from. Opaque on purpose: their shapes belong
 * to the runtime that writes them, and a schema here would be a second
 * definition to keep in step with the first.
 *
 * Mechanical: `timeout: 5000` is one row by primary key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const readChatStateInputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const readChatStateOutputSchema = z.strictObject({
  /** `null` before the conversation's first turn. */
  document: z.unknown(),
  history: z.unknown(),
});

export const readChatStateContract = defineActionContract({
  name: "assistant.readChatState",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Read the stored chat document and provider history for one conversation. Both are opaque payloads owned by the assistant runtime. A conversation with no turns yet reads as two nulls, not as not-found; a conversation belonging to another author or another company is not-found. Company id is never input.`,
  principal: "staff",
  transport: "internal",
  input: readChatStateInputSchema,
  output: readChatStateOutputSchema,
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
