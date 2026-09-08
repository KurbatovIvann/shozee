import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { checkpointPersistedOutcomeSchema } from "../actions/checkpoint-assistant-turn.contract.js";
import {
  GET_MODEL_HISTORY_WINDOW,
  type getModelHistoryOutputSchema,
} from "../actions/get-model-history.contract.js";
import { messageColumns, toMessageView } from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type ModelHistory = z.output<typeof getModelHistoryOutputSchema>;
type ModelHistoryToolRun = ModelHistory["messages"][number]["toolRuns"][number];

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

export async function getStaffModelHistory(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
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
    .select(messageColumns)
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

  return {
    conversationId: env.conversationId,
    messages: messageRows.map((row) => {
      const view = toMessageView(row);
      return {
        id: view.id,
        role: view.role,
        text: view.body,
        toolRuns: byMessage.get(view.id) ?? [],
      };
    }),
  };
}
