/**
 * Internal staff read: persisted prompt-state rows for the model-history
 * builder (SHO-510 / ADR-0034). Not the client conversation view — no
 * `model_trace` on `getConversation`. Mechanical: `timeout: 5000` is one
 * author-owned conversation plus its newest 8 messages and tool-run
 * traces. Missing, foreign-author, and foreign-company ids fail with the
 * same not-found. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  ACTION_NAME_MAX,
  messageRoleSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";

/**
 * Same 8-turn window as `STAFF_ASSISTANT_MODEL_HISTORY_MAX` in
 * `packages/ai`. Duplicated here so this module does not import `@showzy/ai`.
 */
export const GET_MODEL_HISTORY_WINDOW = 8;

export const modelHistoryToolRunSchema = z.object({
  action: z.string(),
  toolCallId: z.string(),
  toolName: z.string().min(1).max(ACTION_NAME_MAX).nullable(),
  modelTrace: z.unknown().nullable(),
});

export const modelHistoryMessageSchema = z.object({
  id: z.uuid(),
  role: messageRoleSchema,
  text: z.string(),
  toolRuns: z.array(modelHistoryToolRunSchema),
});

export const getModelHistoryInputSchema = z.strictObject({
  conversationId: z.uuid(),
});

export const getModelHistoryOutputSchema = z.object({
  conversationId: z.uuid(),
  messages: z.array(modelHistoryMessageSchema),
});

export const getModelHistoryContract = defineActionContract({
  name: "assistant.getModelHistory",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Return the newest 8 author-owned conversation messages as model-history rows: id, role, text, and per-run action / toolCallId / toolName / modelTrace (ADR-0034 prompt state — post-clip façade output, never a projection). toolName is the live ToolSet key used to reconstruct model history; action is the executeAction registry identity. Message id is the append-idempotency merge key for the HTTP mount (same as getConversation). Used only by the staff assistant HTTP mount to build ModelMessage tool-call and tool-result parts. Company id is never input. Internal — not mounted on HTTP and not an AI tool.`,
  principal: "staff",
  transport: "internal",
  input: getModelHistoryInputSchema,
  output: getModelHistoryOutputSchema,
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
