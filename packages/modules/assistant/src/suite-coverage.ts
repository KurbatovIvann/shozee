import type { SuiteCoverageManifest } from "@showzy/core";

export const assistantSuiteCoverage = {
  isolation: [
    "assistant.createConversation",
    "assistant.listConversations",
    "assistant.getConversation",
    "assistant.appendUserMessage",
    "assistant.recordAssistantTurn",
    "assistant.getStaffActor",
    "assistant.getModelHistory",
  ],
  publicProjection: [],
  consumerIsolation: [],
  accountIsolation: [],
  shareIsolation: [],
  idempotency: [
    "assistant.createConversation",
    "assistant.appendUserMessage",
    "assistant.recordAssistantTurn",
  ],
  events: [],
  atomic: [],
} as const satisfies SuiteCoverageManifest;
