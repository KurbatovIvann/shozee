import { appendUserMessage } from "./actions/append-user-message.js";
import { checkpointAssistantTurn } from "./actions/checkpoint-assistant-turn.js";
import { createConversation } from "./actions/create-conversation.js";
import { getConversation } from "./actions/get-conversation.js";
import { getModelHistory } from "./actions/get-model-history.js";
import { getStaffActor } from "./actions/get-staff-actor.js";
import { listConversations } from "./actions/list-conversations.js";
import { readChatState } from "./actions/read-chat-state.js";
import { recordAssistantTurn } from "./actions/record-assistant-turn.js";
import { writeChatState } from "./actions/write-chat-state.js";

export { appendUserMessage };
export { checkpointAssistantTurn };
export { createConversation };
export { getConversation };
export { getModelHistory };
export { getStaffActor };
export { listConversations };
export { readChatState };
export { recordAssistantTurn };
export { writeChatState };

export const assistantActions = [
  createConversation,
  listConversations,
  getConversation,
  appendUserMessage,
  recordAssistantTurn,
  checkpointAssistantTurn,
  getStaffActor,
  getModelHistory,
  readChatState,
  writeChatState,
] as const;
