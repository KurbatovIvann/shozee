import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import type { z } from "zod";

import type {
  recordAssistantTurnInputSchema,
  recordAssistantTurnOutputSchema,
} from "../actions/record-assistant-turn.contract.js";
import {
  messageColumns,
  toToolRunView,
  toolRunColumns,
} from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";
import { touchConversation } from "./touch-conversation.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type RecordInput = z.output<typeof recordAssistantTurnInputSchema>;
type RecordOutput = z.output<typeof recordAssistantTurnOutputSchema>;

export async function recordStaffAssistantTurn(env: {
  readonly ctx: StaffCtx;
  readonly input: RecordInput;
}): Promise<RecordOutput> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  await loadOwnConversation({
    db,
    companyId: ctx.companyId,
    userId: ctx.userId,
    conversationId: input.conversationId,
  });

  const messageId = randomUUID();
  const insertedMessage = (
    await db
      .insert(assistantMessages)
      .values({
        id: messageId,
        companyId: ctx.companyId,
        conversationId: input.conversationId,
        role: "assistant",
        body: input.body,
      })
      .returning(messageColumns)
  )[0];
  if (insertedMessage === undefined) {
    throw new CoreInvariantError(
      "assistant.recordAssistantTurn message insert returned no row",
    );
  }

  const toolRunRows =
    input.toolRuns.length === 0
      ? []
      : await db
          .insert(assistantToolRuns)
          .values(
            input.toolRuns.map((run) => ({
              companyId: ctx.companyId,
              conversationId: input.conversationId,
              actionName: run.actionName,
              toolCallId: run.toolCallId,
              challengeId: run.challengeId,
              resultIds: run.resultIds,
              outcome: run.outcome,
              ...(run.toolName !== undefined ? { toolName: run.toolName } : {}),
              modelTrace:
                run.outcome === "success" &&
                run.modelTrace !== undefined &&
                run.modelTrace !== null
                  ? run.modelTrace
                  : null,
            })),
          )
          .returning(toolRunColumns);

  if (toolRunRows.length !== input.toolRuns.length) {
    throw new CoreInvariantError(
      "assistant.recordAssistantTurn tool-run insert returned a mismatched row count",
    );
  }

  await touchConversation({
    db,
    companyId: ctx.companyId,
    conversationId: input.conversationId,
  });

  ctx.log.info(
    {
      conversation_id: input.conversationId,
      message_id: insertedMessage.id,
      tool_run_count: toolRunRows.length,
    },
    "assistant.recordAssistantTurn recorded assistant turn",
  );

  return {
    conversationId: input.conversationId,
    messageId: insertedMessage.id,
    toolRuns: toolRunRows.map(toToolRunView),
  };
}
