import type { ActionCtx } from "@showzy/core";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq, gte } from "drizzle-orm";
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
  toolName: assistantToolRuns.toolName,
  outcome: assistantToolRuns.outcome,
  modelTrace: assistantToolRuns.modelTrace,
  createdAt: assistantToolRuns.createdAt,
  id: assistantToolRuns.id,
};

/**
 * `created_at` defaults to `now()`, which is transaction time, so an
 * assistant message and the tool runs recorded with it share the exact
 * same timestamp. A run therefore belongs to the newest **assistant**
 * message at or before it — the next row of any role is the wrong bound:
 * a confirmation resume records two assistant messages in a row with no
 * user message between them, and `runAt > nextAt` then handed the second
 * turn's runs to the first.
 */
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
    readonly toolName: string | null;
    readonly outcome: string;
    readonly modelTrace: unknown;
    readonly createdAt: Date;
    readonly id: string;
  }>,
): ModelHistory["messages"] {
  const remaining = [...toolRuns];
  const nextAssistantAt = (index: number): number | undefined => {
    for (let ahead = index + 1; ahead < messages.length; ahead += 1) {
      const candidate = messages[ahead];
      if (candidate !== undefined && candidate.role === "assistant") {
        return candidate.createdAt.getTime();
      }
    }
    return undefined;
  };
  return messages.map((message, index) => {
    const assigned: typeof remaining = [];
    if (message.role === "assistant") {
      const messageAt = message.createdAt.getTime();
      const nextAt = nextAssistantAt(index);
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
        if (nextAt !== undefined && runAt >= nextAt) {
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
        toolName: run.toolName,
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

  const messageRows = await env.ctx.db
    .select(messageColumns)
    .from(assistantMessages)
    .where(messageFilter)
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(GET_MODEL_HISTORY_WINDOW)
    .then((rows) => rows.slice().reverse());

  // `model_trace` is up to 22 000 chars per run, so the run read is bounded
  // by the oldest windowed message. Runs older than that are dropped by
  // `attachToolRunsToMessages` anyway; reading the whole conversation would
  // fetch megabytes of jsonb per chat request to discard nearly all of it.
  const windowStart = messageRows[0]?.createdAt;
  const toolRunRows =
    windowStart === undefined
      ? []
      : await env.ctx.db
          .select(modelHistoryToolRunColumns)
          .from(assistantToolRuns)
          .where(
            and(
              eq(assistantToolRuns.companyId, env.ctx.companyId),
              eq(assistantToolRuns.conversationId, env.conversationId),
              gte(assistantToolRuns.createdAt, windowStart),
            ),
          )
          .orderBy(asc(assistantToolRuns.createdAt), asc(assistantToolRuns.id));

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
