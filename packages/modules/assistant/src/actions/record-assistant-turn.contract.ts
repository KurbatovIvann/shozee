/**
 * Internal staff write: persist an assistant turn (text + tool-run rows).
 * SSE (T4) will call this. Mechanical: `timeout: 5000` is one message
 * insert plus up to 50 tool-run inserts. Result ids are uuids only —
 * never order or document status. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  TOOL_RUNS_MAX,
  messageBodySchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  toolRunInputSchema,
  toolRunViewSchema,
} from "./conversation-view.contract.js";

/** Matches `STAFF_ASSISTANT_CLIP_JSON_MAX` and the `model_trace` CHECK. */
export const MODEL_TRACE_JSON_MAX = 22_000;

function modelTraceJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MODEL_TRACE_JSON_MAX + 1;
  }
}

export const recordToolRunInputSchema = toolRunInputSchema
  .extend({
    modelTrace: z.unknown().optional(),
  })
  .superRefine((run, ctx) => {
    if (run.modelTrace === undefined) {
      return;
    }
    if (modelTraceJsonLength(run.modelTrace) > MODEL_TRACE_JSON_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["modelTrace"],
        message: `modelTrace JSON must be at most ${String(MODEL_TRACE_JSON_MAX)} characters.`,
      });
    }
  });

export const recordAssistantTurnInputSchema = z.strictObject({
  conversationId: z.uuid(),
  body: messageBodySchema,
  toolRuns: z.array(recordToolRunInputSchema).max(TOOL_RUNS_MAX).default([]),
});

export const recordAssistantTurnOutputSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  toolRuns: z.array(toolRunViewSchema),
});

export const recordAssistantTurnContract = defineActionContract({
  name: "assistant.recordAssistantTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Record an assistant turn on a conversation the caller authored: assistant text plus tool-run rows (action name, toolCallId, optional challengeId, result ids, outcome, optional modelTrace). Outcome is success, error, confirmation_required, or choice_required. challengeId is the opaque interaction id for confirmation or choice. Result ids are traces, not order or document status. modelTrace is ADR-0034 prompt state: the post-clip façade output (JSON length at most 22000), stored only for successful runs. Company id is never input. Internal — not mounted on HTTP. Re-submitting the identical payload with the same idempotency key returns the already-recorded turn and does not insert duplicates.`,
  principal: "staff",
  transport: "internal",
  input: recordAssistantTurnInputSchema,
  output: recordAssistantTurnOutputSchema,
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
