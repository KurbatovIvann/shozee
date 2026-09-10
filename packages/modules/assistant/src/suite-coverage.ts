import type { SuiteCoverageManifest } from "@showzy/core";

export const assistantSuiteCoverage = {
  isolation: [
    "assistant.createConversation",
    "assistant.listConversations",
    "assistant.getConversation",
    "assistant.appendUserMessage",
    "assistant.recordAssistantTurn",
    "assistant.checkpointAssistantTurn",
    "assistant.getStaffActor",
    "assistant.getModelHistory",
    "assistant.readChatState",
    "assistant.writeChatState",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [
    "assistant.createConversation",
    "assistant.appendUserMessage",
    "assistant.recordAssistantTurn",
    "assistant.checkpointAssistantTurn",
  ],
  events: [],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
