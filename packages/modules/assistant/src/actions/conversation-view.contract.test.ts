import { describe, expect, it } from "vitest";

import { getConversationOutputSchema } from "./get-conversation.contract.js";
import {
  messageViewSchema,
  toolRunViewSchema,
} from "./conversation-view.contract.js";

describe("assistant conversation client view (ADR-0034)", () => {
  it("does not expose modelTrace on getConversation or tool-run view", () => {
    expect(Object.keys(toolRunViewSchema.shape).toSorted()).toEqual([
      "actionName",
      "challengeId",
      "conversationId",
      "createdAt",
      "id",
      "outcome",
      "resultIds",
      "toolCallId",
    ]);
    expect(toolRunViewSchema.shape).not.toHaveProperty("modelTrace");
    expect(toolRunViewSchema.shape).not.toHaveProperty("toolName");
    expect(Object.keys(getConversationOutputSchema.shape).toSorted()).toEqual(
      [
        "createdAt",
        "id",
        "messages",
        "title",
        "toolRuns",
        "updatedAt",
        "userId",
      ].toSorted(),
    );
    expect(getConversationOutputSchema.shape).not.toHaveProperty("modelTrace");
    expect(messageViewSchema.shape).not.toHaveProperty("modelTrace");
    expect(JSON.stringify(getConversationOutputSchema)).not.toMatch(
      /modelTrace|model_trace/,
    );
  });
});
