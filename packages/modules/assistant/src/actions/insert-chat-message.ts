import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { insertStaffChatMessage } from "../services/chat-messages.js";
import { insertChatMessageContract } from "./insert-chat-message.contract.js";

export const insertChatMessage = implementAction(insertChatMessageContract, {
  handler: async (input, ctx) => {
    const seq = await insertStaffChatMessage({
      ctx,
      conversationId: input.conversationId,
      messageId: input.messageId,
      bind: input.bind,
      message: input.message,
    });
    return { conversationId: input.conversationId, seq };
  },
  auditTarget: conversationAuditTarget,
});
