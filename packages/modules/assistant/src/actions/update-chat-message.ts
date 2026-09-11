import { implementAction } from "@showzy/core";

import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { updateStaffChatMessage } from "../services/chat-messages.js";
import { updateChatMessageContract } from "./update-chat-message.contract.js";

export const updateChatMessage = implementAction(updateChatMessageContract, {
  handler: async (input, ctx) => {
    const updated = await updateStaffChatMessage({
      ctx,
      conversationId: input.conversationId,
      seq: input.seq,
      messageId: input.messageId,
      revision: input.revision,
      message: input.message,
    });
    return {
      conversationId: input.conversationId,
      seq: updated.seq,
      revision: updated.revision,
    };
  },
  auditTarget: conversationAuditTarget,
});
