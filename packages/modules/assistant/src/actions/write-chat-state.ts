import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { writeStaffChatState } from "../services/chat-state.js";
import { writeChatStateContract } from "./write-chat-state.contract.js";

export const writeChatState = implementAction(writeChatStateContract, {
  handler: async (input, ctx) => {
    await writeStaffChatState({
      ctx,
      conversationId: input.conversationId,
      // `in` rather than `!== undefined`: an omitted half leaves the stored
      // value alone, and an explicit null clears it.
      ...("document" in input ? { document: input.document } : {}),
      ...("history" in input ? { history: input.history } : {}),
    });
    return { conversationId: input.conversationId };
  },
  auditTarget: conversationAuditTarget,
});
