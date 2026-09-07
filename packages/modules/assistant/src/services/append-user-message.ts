import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { assistantMessages } from "@showzy/db/schema/assistant";
import type { z } from "zod";

import type {
  appendUserMessageInputSchema,
  appendUserMessageOutputSchema,
} from "../actions/append-user-message.contract.js";
import { messageColumns, toMessageView } from "./conversation-view.js";
import { loadOwnConversation } from "./load-conversation.js";
import { touchConversation } from "./touch-conversation.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type AppendInput = z.output<typeof appendUserMessageInputSchema>;
type MessageView = z.output<typeof appendUserMessageOutputSchema>;

export async function appendStaffUserMessage(env: {
  readonly ctx: StaffCtx;
  readonly input: AppendInput;
}): Promise<MessageView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  await loadOwnConversation({
    db,
    companyId: ctx.companyId,
    userId: ctx.userId,
    conversationId: input.conversationId,
  });

  const messageId = randomUUID();
  const inserted = (
    await db
      .insert(assistantMessages)
      .values({
        id: messageId,
        companyId: ctx.companyId,
        conversationId: input.conversationId,
        role: "user",
        body: input.body,
      })
      .returning(messageColumns)
  )[0];
  if (inserted === undefined) {
    throw new CoreInvariantError(
      "assistant.appendUserMessage insert returned no row",
    );
  }

  await touchConversation({
    db,
    companyId: ctx.companyId,
    conversationId: input.conversationId,
  });

  ctx.log.info(
    { conversation_id: input.conversationId, message_id: inserted.id },
    "assistant.appendUserMessage appended user message",
  );
  return toMessageView(inserted);
}
