import type { ActionCtx } from "@showzy/core";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  GET_MODEL_HISTORY_WINDOW,
  type getModelHistoryOutputSchema,
} from "../actions/get-model-history.contract.js";
import { messageColumns, toMessageView } from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type ModelHistory = z.output<typeof getModelHistoryOutputSchema>;

const modelHistoryToolRunColumns = {
  messageId: assistantToolRuns.messageId,
  actionName: assistantToolRuns.actionName,
  toolCallId: assistantToolRuns.toolCallId,
  toolName: assistantToolRuns.toolName,
  outcome: assistantToolRuns.outcome,
  modelTrace: assistantToolRuns.modelTrace,
};

type ModelHistoryToolRunRow = {
  readonly messageId: string;
  readonly actionName: string;
  readonly toolCallId: string;
  readonly toolName: string | null;
  readonly outcome: string;
  readonly modelTrace: unknown;
};

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
      modelTrace:
        run.outcome === "success" && run.modelTrace !== null
          ? run.modelTrace
          : null,
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
          .orderBy(asc(assistantToolRuns.createdAt), asc(assistantToolRuns.id));

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
