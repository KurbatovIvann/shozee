import { implementAction } from "@showzy/core";

import { readStaffChatState } from "../services/chat-state.js";
import { readChatStateContract } from "./read-chat-state.contract.js";

export const readChatState = implementAction(readChatStateContract, {
  handler: (input, ctx) =>
    readStaffChatState({ ctx, conversationId: input.conversationId }),
});
