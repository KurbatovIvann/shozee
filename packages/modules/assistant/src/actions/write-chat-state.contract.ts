/**
 * Staff write: replace the stored provider history of a conversation.
 *
 * Whole-value, never a delta. The runtime saves exactly the provider messages
 * the turn ran with, so the next turn replays them rather than reconstructing
 * them. The transcript a person reads is the message log, not this (SHO-555).
 *
 * Mechanical: `timeout: 5000` is one upsert by primary key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const writeChatStateInputSchema = z.strictObject({
  conversationId: z.uuid(),
  /** An explicit `null` clears it. */
  history: z.unknown(),
});

export const writeChatStateOutputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const writeChatStateContract = defineActionContract({
  name: "assistant.writeChatState",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Replace the stored provider history for one conversation. The value is whole, never a delta, and is an opaque payload owned by the assistant runtime; null clears it. A conversation belonging to another author or another company is not-found. Company id is never input. Last write wins: a whole-value upsert with no attempt identity to key on, so retrying stores the payload again rather than replaying an earlier one.`,
  principal: "staff",
  transport: "internal",
  input: writeChatStateInputSchema,
  output: writeChatStateOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  /**
   * Not keyed. A key shared across saves would replay an older history over a
   * newer one, and a fresh key per save would protect nothing. The upsert is
   * last-write-wins, which is what a whole-value store should be.
   */
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
