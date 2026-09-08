/**
 * Internal staff write: stepwise assistant-turn persistence (SHO-521).
 * Does not change `assistant.recordAssistantTurn` payload meaning.
 * Mechanical: `timeout: 5000` is one message insert/update or one
 * tool-run insert/update. Company id is never input. Result ids are
 * uuids only — never order or document status.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  ACTION_NAME_MAX,
  actionNameSchema,
  messageBodySchema,
  RESULT_IDS_MAX,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
  TOOL_RUNS_MAX,
  toolCallIdSchema,
  toolRunOutcomeSchema,
} from "./conversation-view.contract.js";
import {
  MODEL_TRACE_JSON_MAX,
  modelTracePostgresJsonbTextLength,
} from "./record-assistant-turn.contract.js";

export const checkpointKindSchema = z.enum([
  "begin",
  "stageRun",
  "finishRun",
  "complete",
]);

export const checkpointPersistedOutcomeSchema = z.enum([
  "started",
  "success",
  "error",
  "confirmation_required",
  "choice_required",
]);

const boundedJsonbField =
  (path: "toolInput" | "modelTrace") =>
  (value: unknown, ctx: z.RefinementCtx) => {
    if (value === undefined) {
      return;
    }
    if (modelTracePostgresJsonbTextLength(value) > MODEL_TRACE_JSON_MAX) {
      ctx.addIssue({
        code: "custom",
        path: [path],
        message: `${path} JSON must be at most ${String(MODEL_TRACE_JSON_MAX)} characters.`,
      });
    }
  };

export const checkpointBeginInputSchema = z.strictObject({
  kind: z.literal("begin"),
  conversationId: z.uuid(),
});

export const checkpointStageRunInputSchema = z
  .strictObject({
    kind: z.literal("stageRun"),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    seq: z.number().int().min(0).max(TOOL_RUNS_MAX),
    actionName: actionNameSchema,
    toolName: z.string().min(1).max(ACTION_NAME_MAX),
    toolCallId: toolCallIdSchema,
    toolInput: z.unknown(),
  })
  .superRefine((input, ctx) => {
    boundedJsonbField("toolInput")(input.toolInput, ctx);
  });

export const checkpointFinishRunInputSchema = z
  .strictObject({
    kind: z.literal("finishRun"),
    conversationId: z.uuid(),
    executionId: z.string().min(1).max(128),
    outcome: toolRunOutcomeSchema,
    modelTrace: z.unknown().optional(),
    resultIds: z.array(z.uuid()).max(RESULT_IDS_MAX).default([]),
    challengeId: z.uuid().optional(),
  })
  .superRefine((input, ctx) => {
    boundedJsonbField("modelTrace")(input.modelTrace, ctx);
  });

export const checkpointCompleteInputSchema = z.strictObject({
  kind: z.literal("complete"),
  conversationId: z.uuid(),
  messageId: z.uuid(),
  body: messageBodySchema,
});

export const checkpointAssistantTurnInputSchema = z.discriminatedUnion("kind", [
  checkpointBeginInputSchema,
  checkpointStageRunInputSchema,
  checkpointFinishRunInputSchema,
  checkpointCompleteInputSchema,
]);

export const checkpointAssistantTurnOutputSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  executionId: z.string().nullable(),
  toolRunId: z.uuid().nullable(),
  seq: z.number().int().nullable(),
  outcome: checkpointPersistedOutcomeSchema.nullable(),
});

export const checkpointAssistantTurnContract = defineActionContract({
  name: "assistant.checkpointAssistantTurn",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Checkpoint an assistant turn on a conversation the caller authored. kind begin inserts one assistant message (body may be empty until complete) and returns messageId — the only message this turn completes into. kind stageRun inserts a tool-run with outcome started, seq, façade toolInput, actionName, toolName, toolCallId, and a server-minted executionId unique per tenant (attempt identity before execute). kind finishRun updates that same executionId row to success, error, choice_required, or confirmation_required and stores bounded modelTrace (ADR-0034 prompt state; PostgreSQL jsonb::text length at most 22000), result ids, and optional challengeId — it does not insert a second tool-run or assistant replica. kind complete writes the final speech on that same messageId. Do not send a recordAssistantTurn payload. Company id is never input. Internal — not mounted on HTTP and not an AI tool. Re-submitting the identical payload with the same idempotency key returns the already-recorded checkpoint and does not mint a second executionId or assistant replica.`,
  principal: "staff",
  transport: "internal",
  input: checkpointAssistantTurnInputSchema,
  output: checkpointAssistantTurnOutputSchema,
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
