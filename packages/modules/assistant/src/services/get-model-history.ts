import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import type { z } from "zod";

import { checkpointPersistedOutcomeSchema } from "../actions/checkpoint-assistant-turn.contract.js";
import {
  GET_MODEL_HISTORY_CHECKPOINT_TURNS_MAX,
  GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX,
  GET_MODEL_HISTORY_UNFINISHED_RESUME_BEGINS_MAX,
  GET_MODEL_HISTORY_UNFINISHED_STARTED_MAX,
  GET_MODEL_HISTORY_WINDOW,
  type getModelHistoryOutputSchema,
} from "../actions/get-model-history.contract.js";
import { messageColumns, toMessageView } from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type ModelHistory = z.output<typeof getModelHistoryOutputSchema>;
type ModelHistoryToolRun = ModelHistory["messages"][number]["toolRuns"][number];

const historyMessageColumns = {
  ...messageColumns,
  turnKey: assistantMessages.turnKey,
};

const modelHistoryToolRunColumns = {
  messageId: assistantToolRuns.messageId,
  actionName: assistantToolRuns.actionName,
  toolCallId: assistantToolRuns.toolCallId,
  toolName: assistantToolRuns.toolName,
  outcome: assistantToolRuns.outcome,
  modelTrace: assistantToolRuns.modelTrace,
  toolInput: assistantToolRuns.toolInput,
  seq: assistantToolRuns.seq,
  executionId: assistantToolRuns.executionId,
};

const unfinishedStartedColumns = {
  messageId: assistantToolRuns.messageId,
  actionName: assistantToolRuns.actionName,
  toolCallId: assistantToolRuns.toolCallId,
  toolName: assistantToolRuns.toolName,
  toolInput: assistantToolRuns.toolInput,
  seq: assistantToolRuns.seq,
  executionId: assistantToolRuns.executionId,
  turnKey: assistantMessages.turnKey,
};

type ModelHistoryToolRunRow = {
  readonly messageId: string;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly toolName: string | null;
  readonly outcome: string;
  readonly modelTrace: unknown;
  readonly toolInput: unknown;
  readonly seq: number | null;
  readonly executionId: string | null;
};

function toHistoryOutcome(outcome: string): ModelHistoryToolRun["outcome"] {
  const parsed = checkpointPersistedOutcomeSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new CoreInvariantError(
      `assistant.getModelHistory stored illegal outcome "${outcome}"`,
    );
  }
  return parsed.data;
}

function toolRunsByMessage(
  toolRuns: readonly ModelHistoryToolRunRow[],
): Map<string, ModelHistory["messages"][number]["toolRuns"]> {
  const byMessage = new Map<
    string,
    ModelHistory["messages"][number]["toolRuns"]
  >();
  for (const run of toolRuns) {
    const runs = byMessage.get(run.messageId) ?? [];
    runs.push({
      action: run.actionName,
      toolCallId: run.toolCallId,
      toolName: run.toolName,
      modelTrace: run.modelTrace ?? null,
      toolInput: run.toolInput ?? null,
      seq: run.seq,
      executionId: run.executionId,
      outcome: toHistoryOutcome(run.outcome),
    });
    byMessage.set(run.messageId, runs);
  }
  return byMessage;
}

function toCheckpointTurns(
  rows: readonly {
    readonly messageId: string;
    readonly turnKey: string | null;
    readonly body: string;
  }[],
): ModelHistory["checkpointTurns"] {
  return rows.flatMap((row) => {
    if (row.turnKey === null) {
      return [];
    }
    return [
      {
        messageId: row.messageId,
        turnKey: row.turnKey,
        hasSpeech: row.body !== "",
        speech: row.body,
      },
    ];
  });
}

const checkpointTurnColumns = {
  messageId: assistantMessages.id,
  turnKey: assistantMessages.turnKey,
  body: assistantMessages.body,
};

/** Duplicated from `@showzy/ai` so this module does not import it. */
const RESUME_TURN_KEY_LIKE = "begin:resume:%";

async function pinCheckpointTurns(options: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly checkpointTurns: ModelHistory["checkpointTurns"];
  readonly keys: readonly string[];
}): Promise<void> {
  const have = new Set(options.checkpointTurns.map((turn) => turn.turnKey));
  const missingKeys = [...new Set(options.keys)].filter(
    (key) => !have.has(key),
  );
  if (missingKeys.length === 0) {
    return;
  }
  const pinnedRows = await options.ctx.db
    .select(checkpointTurnColumns)
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.companyId, options.ctx.companyId),
        eq(assistantMessages.conversationId, options.conversationId),
        eq(assistantMessages.role, "assistant"),
        inArray(assistantMessages.turnKey, missingKeys),
      ),
    );
  options.checkpointTurns.push(...toCheckpointTurns(pinnedRows));
}

export async function getStaffModelHistory(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly includeTurnKeys?: readonly string[];
}): Promise<ModelHistory> {
  await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });

  const messageFilter = and(
    eq(assistantMessages.companyId, env.ctx.companyId),
    eq(assistantMessages.conversationId, env.conversationId),
  );

  const messageRows = await env.ctx.db
    .select(historyMessageColumns)
    .from(assistantMessages)
    .where(messageFilter)
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(GET_MODEL_HISTORY_WINDOW)
    .then((rows) => rows.slice().reverse());

  // Runs carry the assistant message that recorded them, so the read is the
  // window's own rows: no `created_at` inference, and `model_trace` (up to
  // 22 000 chars per run) is never fetched for turns outside the window.
  // Call order is `seq` ascending; pre-T2 rows have null seq and sort last.
  const windowIds = messageRows.map((row) => row.id);
  const toolRunRows =
    windowIds.length === 0
      ? []
      : await env.ctx.db
          .select(modelHistoryToolRunColumns)
          .from(assistantToolRuns)
          .where(
            and(
              eq(assistantToolRuns.companyId, env.ctx.companyId),
              inArray(assistantToolRuns.messageId, windowIds),
            ),
          )
          .orderBy(
            sql`${assistantToolRuns.seq} ASC NULLS LAST`,
            asc(assistantToolRuns.createdAt),
            asc(assistantToolRuns.id),
          );

  const byMessage = toolRunsByMessage(toolRunRows);

  const checkpointTurnRows = await env.ctx.db
    .select(checkpointTurnColumns)
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.companyId, env.ctx.companyId),
        eq(assistantMessages.conversationId, env.conversationId),
        eq(assistantMessages.role, "assistant"),
        isNotNull(assistantMessages.turnKey),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(GET_MODEL_HISTORY_CHECKPOINT_TURNS_MAX)
    .then((rows) => rows.slice().reverse());

  const unfinishedRows = await env.ctx.db
    .select(unfinishedStartedColumns)
    .from(assistantToolRuns)
    .innerJoin(
      assistantMessages,
      and(
        eq(assistantMessages.companyId, assistantToolRuns.companyId),
        eq(assistantMessages.id, assistantToolRuns.messageId),
      ),
    )
    .where(
      and(
        eq(assistantToolRuns.companyId, env.ctx.companyId),
        eq(assistantToolRuns.conversationId, env.conversationId),
        eq(assistantToolRuns.outcome, "started"),
      ),
    )
    .orderBy(
      sql`${assistantToolRuns.seq} ASC NULLS LAST`,
      asc(assistantToolRuns.createdAt),
      asc(assistantToolRuns.id),
    )
    .limit(GET_MODEL_HISTORY_UNFINISHED_STARTED_MAX);

  const unfinishedStartedRuns: ModelHistory["unfinishedStartedRuns"] = [];
  for (const run of unfinishedRows) {
    if (run.executionId === null || run.seq === null) {
      continue;
    }
    unfinishedStartedRuns.push({
      messageId: run.messageId,
      turnKey: run.turnKey,
      executionId: run.executionId,
      seq: run.seq,
      action: run.actionName,
      toolName: run.toolName,
      toolCallId: run.toolCallId,
      toolInput: run.toolInput ?? null,
    });
  }

  const checkpointTurns = [...toCheckpointTurns(checkpointTurnRows)];
  const have = new Set(checkpointTurns.map((turn) => turn.turnKey));
  const unfinishedResumeBeginRows = await env.ctx.db
    .select(checkpointTurnColumns)
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.companyId, env.ctx.companyId),
        eq(assistantMessages.conversationId, env.conversationId),
        eq(assistantMessages.role, "assistant"),
        isNotNull(assistantMessages.turnKey),
        like(assistantMessages.turnKey, RESUME_TURN_KEY_LIKE),
        eq(assistantMessages.body, ""),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(GET_MODEL_HISTORY_UNFINISHED_RESUME_BEGINS_MAX);
  for (const row of unfinishedResumeBeginRows) {
    if (row.turnKey === null || have.has(row.turnKey)) {
      continue;
    }
    checkpointTurns.push(...toCheckpointTurns([row]));
    have.add(row.turnKey);
  }
  await pinCheckpointTurns({
    ctx: env.ctx,
    conversationId: env.conversationId,
    checkpointTurns,
    keys: [...new Set(env.includeTurnKeys ?? [])].slice(
      0,
      GET_MODEL_HISTORY_INCLUDE_TURN_KEYS_MAX,
    ),
  });

  return {
    conversationId: env.conversationId,
    messages: messageRows.map((row) => {
      const view = toMessageView(row);
      return {
        id: view.id,
        role: view.role,
        text: view.body,
        turnKey: row.turnKey,
        toolRuns: byMessage.get(view.id) ?? [],
      };
    }),
    unfinishedStartedRuns,
    checkpointTurns,
  };
}
