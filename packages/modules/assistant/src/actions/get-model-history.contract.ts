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
  checkpointPersistedOutcomeSchema,
  checkpointTurnKeySchema,
} from "./checkpoint-assistant-turn.contract.js";
import {
  ACTION_NAME_MAX,
  MESSAGE_BODY_MAX,
  messageRoleSchema,
  STAFF_CONVERSATION_AUTHOR_INVARIANT,
} from "./conversation-view.contract.js";

/**
 * Same 8-turn window as `STAFF_ASSISTANT_MODEL_HISTORY_MAX` in
 * `packages/ai`. Duplicated here so this module does not import `@showzy/ai`.
 * Recovery membership does not use this clip.
 */
export const GET_MODEL_HISTORY_WINDOW = 8;

/** Bounded sibling list of in-flight started runs for crash recovery. */
export const GET_MODEL_HISTORY_UNFINISHED_STARTED_MAX = 64;

/** Bounded sibling list of assistant rows that have a turnKey. */
export const GET_MODEL_HISTORY_CHECKPOINT_TURNS_MAX = 256;

/** Exact turnKeys the host pins so Phase B lookup is not the newest-256 clip. */
export const GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX = 8;

/**
 * Conversation-scoped empty `begin:resume:` begins pinned into
 * checkpointTurns so chat write refusal does not depend on the 256 cap.
 */
export const GET_MODEL_HISTORY_UNFINISHED_RESUME_BEGINS_MAX = 64;

export const modelHistoryToolRunSchema = z.object({
  action: z.string(),
  toolCallId: z.string(),
  toolName: z.string().min(1).max(ACTION_NAME_MAX).nullable(),
  modelTrace: z.unknown().nullable(),
  /**
   * Façade/tool args. Null on pre-T2 rows; the history builder reconstructs
   * `input: {}` when this is absent. Never exposed on getConversation.
   */
  toolInput: z.unknown().nullable(),
  seq: z.number().int().nullable(),
  executionId: z.string().nullable(),
  outcome: checkpointPersistedOutcomeSchema,
});

export const modelHistoryMessageSchema = z.object({
  id: z.uuid(),
  role: messageRoleSchema,
  text: z.string(),
  /**
   * Host begin identity. Null on user rows and pre-SHO-539 assistant
   * rows. Recovery must not auto-execute started runs when this is null.
   */
  turnKey: checkpointTurnKeySchema.nullable(),
  toolRuns: z.array(modelHistoryToolRunSchema),
});

export const modelHistoryUnfinishedStartedRunSchema = z.object({
  messageId: z.uuid(),
  turnKey: checkpointTurnKeySchema.nullable(),
  executionId: z.string().min(1).max(128),
  seq: z.number().int(),
  action: z.string(),
  toolName: z.string().min(1).max(ACTION_NAME_MAX).nullable(),
  toolCallId: z.string(),
  toolInput: z.unknown().nullable(),
});

export const modelHistoryCheckpointTurnSchema = z.object({
  messageId: z.uuid(),
  turnKey: checkpointTurnKeySchema,
  hasSpeech: z.boolean(),
  /** Assistant body. Empty when the begin has not completed speech. */
  speech: z.string().max(MESSAGE_BODY_MAX),
});

export const getModelHistoryInputSchema = z.strictObject({
  conversationId: z.uuid(),
  includeTurnKeys: z
    .array(checkpointTurnKeySchema)
    .max(GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX)
    .optional(),
});

export const getModelHistoryOutputSchema = z.object({
  conversationId: z.uuid(),
  messages: z.array(modelHistoryMessageSchema),
  unfinishedStartedRuns: z
    .array(modelHistoryUnfinishedStartedRunSchema)
    .max(GET_MODEL_HISTORY_UNFINISHED_STARTED_MAX),
  checkpointTurns: z
    .array(modelHistoryCheckpointTurnSchema)
    .max(
      GET_MODEL_HISTORY_CHECKPOINT_TURNS_MAX +
        GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX +
        GET_MODEL_HISTORY_UNFINISHED_RESUME_BEGINS_MAX,
    ),
});

export const getModelHistoryContract = defineActionContract({
  name: "assistant.getModelHistory",
  description: `${STAFF_CONVERSATION_AUTHOR_INVARIANT} Return the newest 8 author-owned conversation messages as model-history rows: id, role, text, turnKey (host begin identity; null on user rows and pre-SHO-539 assistant rows), and per-run action / toolCallId / toolName / modelTrace / toolInput / seq / executionId / outcome (ADR-0034 prompt state — post-clip façade output, never a projection). Includes started runs on those 8 messages. Also returns unfinishedStartedRuns (conversation-scoped started rows, including messages outside the 8-message prompt window) and checkpointTurns (newest assistant rows with a non-null turnKey plus hasSpeech and speech, capped) so crash recovery and Phase B state do not depend on the prompt clip. checkpointTurns.speech is the assistant body so a pinned completed resume can replay original Phase B prose when the 8-message window is later filler. Optional includeTurnKeys pins exact begin identities (Phase B begin:resume:\${pendingId}) so a completed resume clipped from the 256 newest checkpointTurns is still returned and is not treated as missing. Conversation-scoped unfinished empty begin:resume: rows are pinned into checkpointTurns the same way so chat write refusal does not depend on the 256 cap. Recovery must not auto-execute started rows whose turnKey is null. toolInput is façade/tool args when present; pre-T2 rows without toolInput reconstruct as {}. Order runs by seq ascending, not created_at alone. toolName is the live ToolSet key used to reconstruct model history; action is the executeAction registry identity. executionId is the server-minted attempt identity. Message id is the append-idempotency merge key for the HTTP mount (same as getConversation). Used only by the staff assistant HTTP mount to build ModelMessage tool-call and tool-result parts. Company id is never input. Internal — not mounted on HTTP and not an AI tool.`,
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
