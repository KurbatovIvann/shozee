import { createConversation } from "./actions/create-conversation.js";
import { getStaffActor } from "./actions/get-staff-actor.js";
import { insertChatMessage } from "./actions/insert-chat-message.js";
import { listConversations } from "./actions/list-conversations.js";
import { readChatMessages } from "./actions/read-chat-messages.js";
import { readChatState } from "./actions/read-chat-state.js";
import { updateChatMessage } from "./actions/update-chat-message.js";
import { writeChatState } from "./actions/write-chat-state.js";

export { createConversation };
export { getStaffActor };
export { insertChatMessage };
export { listConversations };
export { readChatMessages };
export { readChatState };
export { updateChatMessage };
export { writeChatState };

export const assistantActions = [
  createConversation,
  listConversations,
  getStaffActor,
  readChatState,
  writeChatState,
  readChatMessages,
  insertChatMessage,
  updateChatMessage,
] as const;
