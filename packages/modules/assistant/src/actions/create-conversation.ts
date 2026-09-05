import { implementAction } from "@showzy/core";
import { conversationAuditTarget } from "../services/conversation-audit-target.js";
import { createStaffConversation } from "../services/create-conversation.js";
import { createConversationContract } from "./create-conversation.contract.js";

export const createConversation = implementAction(createConversationContract, {
  handler: async (input, ctx) => {
    return createStaffConversation({ ctx, input });
  },
  auditTarget: conversationAuditTarget,
});
