import type { SuiteCoverageManifest } from "@showzy/core";

export const assistantSuiteCoverage = {
  isolation: [
    "assistant.createConversation",
    "assistant.listConversations",
    "assistant.getStaffActor",
    "assistant.readChatState",
    "assistant.writeChatState",
    "assistant.readChatMessages",
    "assistant.insertChatMessage",
    "assistant.updateChatMessage",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: ["assistant.createConversation"],
  events: [],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
