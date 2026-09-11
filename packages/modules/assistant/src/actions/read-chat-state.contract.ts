/**
 * Staff read: the provider history of an `assistant-kit` conversation — what
 * the next turn is built from.
 *
 * Opaque on purpose: its shape belongs to the runtime that writes it, and a
 * schema here would be a second definition to keep in step with the first. The
 * transcript a person reads is the message log, not this (SHO-555).
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
  history: z.unknown(),
});

export const readChatStateContract = defineActionContract({
  name: "assistant.readChatState",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Read the stored provider history for one conversation. It is an opaque payload owned by the assistant runtime. A conversation with no turns yet reads as null, not as not-found; a conversation belonging to another author or another company is not-found. Company id is never input.`,
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
