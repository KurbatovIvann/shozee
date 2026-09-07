/**
 * Internal staff write: persist an assistant turn (text + tool-run rows).
 * SSE (T4) will call this. Mechanical: `timeout: 5000` is one message
 * insert plus up to 50 tool-run inserts. Result ids are uuids only —
 * never order or document status. Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  ACTION_NAME_MAX,
  TOOL_RUNS_MAX,
  messageBodySchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  toolRunInputSchema,
  toolRunViewSchema,
} from "./conversation-view.contract.js";

/** Matches `STAFF_ASSISTANT_CLIP_JSON_MAX` and the `model_trace` CHECK. */
export const MODEL_TRACE_JSON_MAX = 22_000;

/**
 * PostgreSQL `jsonb::text` inserts a space after every structural `:` and
 * `,`. Compact `JSON.stringify` is shorter, so a stringify-budgeted
 * payload can fail CHECK `length(model_trace::text) <= 22000`. Budget
 * Zod against this postgres-shaped length so the CHECK cannot reject a
 * Zod-accepted payload. Do not raise the 22000 bound. Keep in lockstep
 * with `staffAssistantPostgresJsonbTextChars` in `@showzy/ai`.
 */
export function modelTracePostgresJsonbTextLength(value: unknown): number {
  let compact: string;
  try {
    compact = JSON.stringify(value);
  } catch {
    return MODEL_TRACE_JSON_MAX + 1;
  }
  if (typeof compact !== "string") {
    return MODEL_TRACE_JSON_MAX + 1;
  }
  let extra = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === ":" || character === ",") {
      extra += 1;
    }
  }
  return compact.length + extra;
}

export const recordToolRunInputSchema = toolRunInputSchema
  .extend({
    modelTrace: z.unknown().optional(),
    toolName: z.string().min(1).max(ACTION_NAME_MAX).optional(),
  })
  .superRefine((run, ctx) => {
    if (run.modelTrace === undefined) {
      return;
    }
    if (
      modelTracePostgresJsonbTextLength(run.modelTrace) > MODEL_TRACE_JSON_MAX
    ) {
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
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Record an assistant turn on a conversation the caller authored: assistant text plus tool-run rows (action name, toolCallId, optional challengeId, result ids, outcome, optional modelTrace, optional toolName). Outcome is success, error, confirmation_required, or choice_required. challengeId is the opaque interaction id for confirmation or choice. Result ids are traces, not order or document status. modelTrace is ADR-0034 prompt state: the post-clip façade output (PostgreSQL jsonb::text length at most 22000), stored only for successful runs. toolName is the live ToolSet key (orders_list_page) used to reconstruct model history; actionName stays the executeAction registry identity. Company id is never input. Internal — not mounted on HTTP. Re-submitting the identical payload with the same idempotency key returns the already-recorded turn and does not insert duplicates.`,
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
