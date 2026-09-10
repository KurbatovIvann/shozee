import { implementAction } from "@showzy/core";

import { readStaffChatMessages } from "../services/chat-messages.js";
import { readChatMessagesContract } from "./read-chat-messages.contract.js";

export const readChatMessages = implementAction(readChatMessagesContract, {
  handler: (input, ctx) =>
    readStaffChatMessages({
      ctx,
      conversationId: input.conversationId,
      limit: input.limit,
      ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
    }),
});
