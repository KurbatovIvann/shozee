import { createConversation } from "./actions/create-conversation.js";
import { getStaffActor } from "./actions/get-staff-actor.js";
import { listConversations } from "./actions/list-conversations.js";
import { readChatState } from "./actions/read-chat-state.js";
import { writeChatState } from "./actions/write-chat-state.js";

export { createConversation };
export { getStaffActor };
export { listConversations };
export { readChatState };
export { writeChatState };

export const assistantActions = [
  createConversation,
  listConversations,
  getStaffActor,
  readChatState,
  writeChatState,
] as const;
