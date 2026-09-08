import { describe, expect, it } from "vitest";

import {
  AssistantConversationMissingError,
  assistantChatUrl,
  clipAssistantInput,
  staffAssistantChatBody,
  STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX,
} from "./assistant-chat-body";

const conversationId = "11111111-1111-4111-8111-111111111111";

describe("assistantChatUrl", () => {
  it("joins the live chat path without a trailing slash", () => {
    expect(assistantChatUrl("https://api.example.com/")).toBe(
      "https://api.example.com/assistant/chat",
    );
  });
});

describe("staffAssistantChatBody", () => {
  it("builds conversationId, text, and locale without companyId", () => {
    const body = staffAssistantChatBody({
      conversationId,
      text: "List orders",
      locale: "uk",
    });
    expect(body).toEqual({
      conversationId,
      text: "List orders",
      locale: "uk",
    });
    expect(JSON.stringify(body)).not.toContain("companyId");
    expect(body).not.toHaveProperty("messageId");
    expect(body).not.toHaveProperty("messages");
  });

  it("sends an explicit English locale", () => {
    expect(
      staffAssistantChatBody({
        conversationId,
        text: "List orders",
        locale: "en",
      }).locale,
    ).toBe("en");
  });

  it("throws when the conversation is missing", () => {
    expect(() =>
      staffAssistantChatBody({
        conversationId: null,
        text: "List orders",
      }),
    ).toThrow(AssistantConversationMissingError);
  });
});

describe("clipAssistantInput", () => {
  it("trims and caps at the append body limit", () => {
    expect(clipAssistantInput("  hello  ")).toBe("hello");
    expect(
      clipAssistantInput("x".repeat(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX + 8))
        .length,
    ).toBe(STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX);
  });
});
