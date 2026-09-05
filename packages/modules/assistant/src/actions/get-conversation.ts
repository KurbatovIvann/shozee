import { implementAction } from "@showzy/core";
import { getStaffConversation } from "../services/get-conversation.js";
import { getConversationContract } from "./get-conversation.contract.js";

export const getConversation = implementAction(getConversationContract, {
  handler: async (input, ctx) => {
    return getStaffConversation({
      ctx,
      conversationId: input.conversationId,
    });
  },
});
