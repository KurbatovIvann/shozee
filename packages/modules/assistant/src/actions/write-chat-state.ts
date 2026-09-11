import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { writeStaffChatState } from "../services/chat-state.js";
import { writeChatStateContract } from "./write-chat-state.contract.js";

export const writeChatState = implementAction(writeChatStateContract, {
  handler: async (input, ctx) => {
    await writeStaffChatState({
      ctx,
      conversationId: input.conversationId,
      history: input.history,
    });
    return { conversationId: input.conversationId };
  },
  auditTarget: conversationAuditTarget,
});
