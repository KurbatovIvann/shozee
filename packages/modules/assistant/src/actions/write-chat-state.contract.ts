/**
 * Staff write: replace the stored chat document, the provider history, or both.
 *
 * Whole-value, never a delta. The runtime applies a change to the state it read
 * and stores the result, so a row is always a complete document rather than a
 * fold over appends — which is what makes a reload byte-identical to the live
 * turn instead of a second derivation of it.
 *
 * Mechanical: `timeout: 5000` is one upsert by primary key.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { STAFF_CONVERSATION_AUTHOR_INVARIANT } from "./conversation-view.contract.js";

export const writeChatStateInputSchema = z.strictObject({
  conversationId: z.uuid(),
  /** Omitted leaves the stored value alone; an explicit `null` clears it. */
  document: z.unknown().optional(),
  history: z.unknown().optional(),
});

export const writeChatStateOutputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const writeChatStateContract = defineActionContract({
  name: "assistant.writeChatState",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Replace the stored chat document, the provider history, or both, for one conversation. Values are whole, never deltas, and are opaque payloads owned by the assistant runtime. An omitted field leaves the stored value alone; an explicit null clears it; neither is a validation error. A conversation belonging to another author or another company is not-found. Company id is never input. Last write wins: a whole-value upsert with no attempt identity to key on, so retrying stores the payload again rather than replaying an earlier one.`,
  principal: "staff",
  transport: "internal",
  input: writeChatStateInputSchema,
  output: writeChatStateOutputSchema,
  permissions: ["assistant:use"],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  /**
   * Not keyed. A turn writes the document several times with different content,
   * so a key that stayed the same across them would replay the first write and
   * lose the rest, and a fresh key per write would protect nothing. The upsert
   * is last-write-wins, which is what a whole-value store should be.
   */
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
