import { describe, expect, it } from "vitest";

import {
  AssistantConversationMissingError,
  assistantChatUrl,
  clipAssistantInput,
  prepareStaffAssistantChatRequest,
  prepareStaffAssistantSendMessagesRequest,
  staffChatWireMessages,
  STAFF_ASSISTANT_CHAT_MESSAGE_TEXT_MAX,
  STAFF_ASSISTANT_CHAT_MESSAGES_MAX,
} from "./assistant-chat-body";

const conversationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";

describe("assistantChatUrl", () => {
  it("joins the SSE mount path without a trailing slash", () => {
    expect(assistantChatUrl("https://api.example.com/")).toBe(
      "https://api.example.com/assistant/chat",
    );
  });
});

describe("staffChatWireMessages", () => {
  it("keeps message ids and echoes data-confirmation parts", () => {
    expect(
      staffChatWireMessages([
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Confirmation required." },
            {
              type: "data-confirmation",
              data: {
                status: "confirmation_required",
                challengeId,
                summary: "Delete this archived customer.",
                expiresAt: "2026-09-01T12:00:00.000Z",
                actionName: "customers.deleteCustomer",
                toolCallId: "call-delete",
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Delete the customer" }],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Confirmation required." },
          {
            type: "data-confirmation",
            data: {
              status: "confirmation_required",
              challengeId,
              summary: "Delete this archived customer.",
              expiresAt: "2026-09-01T12:00:00.000Z",
              actionName: "customers.deleteCustomer",
              toolCallId: "call-delete",
            },
          },
        ],
      },
    ]);
  });

  it("keeps valid data-choice envelopes and drops canonical extras", () => {
    const choiceId = "33333333-3333-4333-8333-333333333333";
    const optionId = "88888888-8888-4888-8888-888888888888";
    const envelope = {
      status: "needs_choice" as const,
      challengeId: choiceId,
      reason: "variant_required" as const,
      productName: "Macarons",
      options: [{ id: optionId, label: "Lemon" }],
      optionsTruncated: false,
    };
    expect(
      staffChatWireMessages([
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Select a variant." },
            {
              type: "data-choice",
              data: {
                ...envelope,
                canonicalInput: {
                  customer: { by: "id", id: choiceId },
                  items: [],
                },
                target: {
                  lineIndex: 0,
                  productId: choiceId,
                  productName: "Macarons",
                },
                optionMap: { [optionId]: choiceId },
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Select a variant." },
          { type: "data-choice", data: envelope },
        ],
      },
    ]);
  });

  it("windows history to the SSE mount message cap", () => {
    const messages = Array.from(
      { length: STAFF_ASSISTANT_CHAT_MESSAGES_MAX + 1 },
      (_, index) => ({
        id: `m${String(index)}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        parts: [{ type: "text" as const, text: `turn-${String(index)}` }],
      }),
    );
    const wired = staffChatWireMessages(messages);
    expect(wired).toHaveLength(STAFF_ASSISTANT_CHAT_MESSAGES_MAX);
    expect(wired[0]?.id).toBe("m1");
    expect(wired.at(-1)?.id).toBe(
      `m${String(STAFF_ASSISTANT_CHAT_MESSAGES_MAX)}`,
    );
  });

  it("drops data-presentation so the envelope is not echoed to the model", () => {
    expect(
      staffChatWireMessages([
        {
          id: "a1",
          role: "assistant",
          parts: [
            { type: "text", text: "Немає замовлень." },
            {
              type: "data-presentation",
              data: {
                surface: "orders-list",
                version: 1,
                toolCallIds: ["call-list"],
              },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Немає замовлень." }],
      },
    ]);
  });
});

describe("prepareStaffAssistantChatRequest", () => {
  it("builds the strict body without companyId", () => {
    const prepared = prepareStaffAssistantChatRequest({
      conversationId,
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "List orders" }],
        },
      ],
    });
    expect(prepared.body).toEqual({
      conversationId,
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "List orders" }],
        },
      ],
      locale: "uk",
    });
    expect(prepared.body).not.toHaveProperty("companyId");
    expect(JSON.stringify(prepared.body)).not.toContain("companyId");
  });

  it("sends an explicit English locale", () => {
    const prepared = prepareStaffAssistantChatRequest({
      conversationId,
      locale: "en",
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "List orders" }],
        },
      ],
    });
    expect(prepared.body.locale).toBe("en");
  });

  it("throws when the conversation is missing", () => {
    expect(() =>
      prepareStaffAssistantChatRequest({
        conversationId: null,
        messages: [],
      }),
    ).toThrow(AssistantConversationMissingError);
  });
});

describe("prepareStaffAssistantSendMessagesRequest", () => {
  it("returns the request headers including the confirmation challenge", () => {
    const headers = {
      cookie: "better-auth.session_token=abc",
      "x-company-id": "company-a",
      "x-confirmation-challenge-id": challengeId,
    };
    const prepared = prepareStaffAssistantSendMessagesRequest({
      conversationId,
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Delete the customer" }],
        },
      ],
      headers,
    });
    expect(prepared.headers).toEqual(headers);
    expect(prepared.credentials).toBe("omit");
    expect(prepared.body).not.toHaveProperty("companyId");
    expect(prepared.body.locale).toBe("uk");
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
