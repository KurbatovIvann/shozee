import type { ActionCtx } from "@showzy/core";
import {
  assistantMessages,
  assistantToolRuns,
} from "@showzy/db/schema/assistant";
import { and, asc, desc, eq } from "drizzle-orm";
import type { z } from "zod";

import type { getConversationOutputSchema } from "../actions/get-conversation.contract.js";
import {
  messageColumns,
  toConversationView,
  toMessageView,
  toToolRunView,
  toolRunColumns,
} from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type ConversationDetail = z.output<typeof getConversationOutputSchema>;

export async function getStaffConversation(env: {
  readonly ctx: StaffCtx;
  readonly conversationId: string;
  readonly limit?: number;
}): Promise<ConversationDetail> {
  const conversation = await loadOwnConversation({
    db: env.ctx.db,
    companyId: env.ctx.companyId,
    userId: env.ctx.userId,
    conversationId: env.conversationId,
  });

  const messageFilter = and(
    eq(assistantMessages.companyId, env.ctx.companyId),
    eq(assistantMessages.conversationId, env.conversationId),
  );

  const [messages, toolRuns] = await Promise.all([
    env.limit === undefined
      ? env.ctx.db
          .select(messageColumns)
          .from(assistantMessages)
          .where(messageFilter)
          .orderBy(asc(assistantMessages.createdAt), asc(assistantMessages.id))
      : env.ctx.db
          .select(messageColumns)
          .from(assistantMessages)
          .where(messageFilter)
          .orderBy(
            desc(assistantMessages.createdAt),
            desc(assistantMessages.id),
          )
          .limit(env.limit)
          .then((rows) => rows.slice().reverse()),
    env.ctx.db
      .select(toolRunColumns)
      .from(assistantToolRuns)
      .where(
        and(
          eq(assistantToolRuns.companyId, env.ctx.companyId),
          eq(assistantToolRuns.conversationId, env.conversationId),
        ),
      )
      .orderBy(asc(assistantToolRuns.createdAt), asc(assistantToolRuns.id)),
  ]);

  return {
    ...toConversationView(conversation),
    messages: messages.map(toMessageView),
    toolRuns: toolRuns.map(toToolRunView),
  };
}
