import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANY_SELECTOR_HEADER,
  CONFIRMATION_CHALLENGE_HEADER,
} from "@showzy/contract";

const fetchMock = vi.fn();

vi.mock("expo/fetch", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args) as Promise<Response>,
}));

import { createStaffAssistantTransport } from "./assistant-chat-transport";

const conversationId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";

function jsonRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    throw new Error("expected JSON string body");
  }
  return JSON.parse(body);
}

function headerValue(
  headers: HeadersInit | undefined,
  name: string,
): string | null {
  if (headers === undefined) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return found?.[1] ?? null;
  }
  const record = headers;
  const direct = record[name];
  if (typeof direct === "string") {
    return direct;
  }
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower && typeof value === "string") {
      return value;
    }
  }
  return null;
}

describe("createStaffAssistantTransport", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    });
  });

  it("forwards x-confirmation-challenge-id when leftover resume() headers are set", async () => {
    const transport = createStaffAssistantTransport({
      apiUrl: "https://api.example.com",
      getCookie: () => "better-auth.session_token=abc",
      getCompanyId: () => "company-a",
      getConversationId: () => conversationId,
    });
    await transport
      .sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        abortSignal: undefined,
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "Delete the customer" }],
          },
        ],
        headers: { [CONFIRMATION_CHALLENGE_HEADER]: challengeId },
      })
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(headerValue(init?.headers, CONFIRMATION_CHALLENGE_HEADER)).toBe(
      challengeId,
    );
    expect(headerValue(init?.headers, COMPANY_SELECTOR_HEADER)).toBe(
      "company-a",
    );
    expect(headerValue(init?.headers, "cookie")).toBe(
      "better-auth.session_token=abc",
    );
    expect(JSON.stringify(init?.body ?? "")).not.toContain("companyId");
    const body = jsonRequestBody(init?.body) as {
      text?: string;
      messageId?: string;
      messages?: unknown;
    };
    expect(body).not.toHaveProperty("text");
    expect(body).not.toHaveProperty("messageId");
    expect(JSON.stringify(body.messages ?? [])).not.toContain(
      "Delete the customer",
    );
  });

  it("sends text and a stable messageId without messages on a fresh turn", async () => {
    const transport = createStaffAssistantTransport({
      apiUrl: "https://api.example.com",
      getCookie: () => "better-auth.session_token=abc",
      getCompanyId: () => "company-a",
      getConversationId: () => conversationId,
    });
    const userMessage = {
      id: "attempt-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "List orders" }],
    };
    await transport
      .sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        abortSignal: undefined,
        messages: [userMessage],
      })
      .catch(() => undefined);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const firstBody = jsonRequestBody(firstInit?.body) as {
      text?: string;
      messageId?: string;
      messages?: unknown;
      conversationId?: string;
    };
    expect(firstBody).toEqual({
      conversationId,
      text: "List orders",
      messageId: "attempt-1",
      locale: "uk",
    });
    expect(firstBody).not.toHaveProperty("messages");

    await transport
      .sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        abortSignal: undefined,
        messages: [userMessage],
      })
      .catch(() => undefined);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const retryBody = jsonRequestBody(retryInit?.body) as {
      messageId?: string;
    };
    expect(retryBody.messageId).toBe("attempt-1");

    await transport
      .sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        abortSignal: undefined,
        messages: [
          {
            id: "attempt-2",
            role: "user",
            parts: [{ type: "text", text: "List orders" }],
          },
        ],
      })
      .catch(() => undefined);
    const nextInit = fetchMock.mock.calls[2]?.[1] as RequestInit | undefined;
    const nextBody = jsonRequestBody(nextInit?.body) as {
      messageId?: string;
    };
    expect(nextBody.messageId).toBe("attempt-2");
  });
});
