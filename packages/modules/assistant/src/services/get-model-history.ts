import type { ActionCtx } from "@showzy/core";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq } from "drizzle-orm";
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
  actionName: assistantToolRuns.actionName,
  toolCallId: assistantToolRuns.toolCallId,
  outcome: assistantToolRuns.outcome,
  modelTrace: assistantToolRuns.modelTrace,
  createdAt: assistantToolRuns.createdAt,
  id: assistantToolRuns.id,
};

function attachToolRunsToMessages(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: Date;
  }>,
  toolRuns: ReadonlyArray<{
    readonly actionName: string;
    readonly toolCallId: string;
    readonly outcome: string;
    readonly modelTrace: unknown;
    readonly createdAt: Date;
    readonly id: string;
  }>,
): ModelHistory["messages"] {
  const remaining = [...toolRuns];
  return messages.map((message, index) => {
    const next = messages[index + 1];
    const assigned: typeof remaining = [];
    if (message.role === "assistant") {
      const messageAt = message.createdAt.getTime();
      const nextAt = next?.createdAt.getTime();
      while (remaining.length > 0) {
        const run = remaining[0];
        if (run === undefined) {
          break;
        }
        const runAt = run.createdAt.getTime();
        if (runAt < messageAt) {
          remaining.shift();
          continue;
        }
        if (nextAt !== undefined && runAt > nextAt) {
          break;
        }
        assigned.push(run);
        remaining.shift();
      }
    }
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      toolRuns: assigned.map((run) => ({
        action: run.actionName,
        toolCallId: run.toolCallId,
        modelTrace:
          run.outcome === "success" && run.modelTrace !== null
            ? run.modelTrace
            : null,
      })),
    };
  });
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

  const [messageRows, toolRunRows] = await Promise.all([
    env.ctx.db
      .select(messageColumns)
      .from(assistantMessages)
      .where(messageFilter)
      .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
      .limit(GET_MODEL_HISTORY_WINDOW)
      .then((rows) => rows.slice().reverse()),
    env.ctx.db
      .select(modelHistoryToolRunColumns)
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, env.ctx.companyId),
          eq(assistantToolRuns.conversationId, env.conversationId),
        ),
      )
      .orderBy(asc(assistantToolRuns.createdAt), asc(assistantToolRuns.id)),
  ]);

  const messages = messageRows.map((row) => {
    const view = toMessageView(row);
    return {
      id: view.id,
      role: view.role,
      text: view.body,
      createdAt: row.createdAt,
    };
  });

  return {
    conversationId: env.conversationId,
    messages: attachToolRunsToMessages(messages, toolRunRows),
  };
}
