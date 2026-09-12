import { acceptTurn } from "./actions/accept-turn.js";
import { createConversation } from "./actions/create-conversation.js";
import { finishTurn } from "./actions/finish-turn.js";
import { getStaffActor } from "./actions/get-staff-actor.js";
import { insertChatMessage } from "./actions/insert-chat-message.js";
import { interruptTurn } from "./actions/interrupt-turn.js";
import { listConversations } from "./actions/list-conversations.js";
import { listStaleTurns } from "./actions/list-stale-turns.js";
import { readActiveTurn } from "./actions/read-active-turn.js";
import { readChatMessages } from "./actions/read-chat-messages.js";
import { readChatState } from "./actions/read-chat-state.js";
import { readLatestInterruptedTurn } from "./actions/read-latest-interrupted-turn.js";
import { readTurnForJob } from "./actions/read-turn-for-job.js";
import { startTurn } from "./actions/start-turn.js";
import { updateChatMessage } from "./actions/update-chat-message.js";
import { writeChatState } from "./actions/write-chat-state.js";

export { acceptTurn };
export { createConversation };
export { finishTurn };
export { getStaffActor };
export { insertChatMessage };
export { interruptTurn };
export { listConversations };
export { listStaleTurns };
export { readActiveTurn };
export { readChatMessages };
export { readChatState };
export { readLatestInterruptedTurn };
export { readTurnForJob };
export { startTurn };
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
  acceptTurn,
  startTurn,
  finishTurn,
  listStaleTurns,
  readTurnForJob,
  interruptTurn,
  readActiveTurn,
  readLatestInterruptedTurn,
] as const;
