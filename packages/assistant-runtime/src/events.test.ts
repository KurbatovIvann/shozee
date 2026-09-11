import type { AssistantPublishedEvent } from "@showzy/validation/assistant-events";
import { describe, expect, it } from "vitest";

import {
  assistantConversationChannel,
  assistantPresenceKey,
  assistantStreamSlotsKey,
  decodeAssistantEvent,
  encodeAssistantEvent,
} from "./events.js";

const COMPANY = "879e8662-6a94-4a4f-8cd9-43a1ce72c4ef";
const OTHER_COMPANY = "11111111-1111-4111-8111-1111111111aa";
const CONVERSATION = "4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const COMMAND = "9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0";

const address = { companyId: COMPANY, conversationId: CONVERSATION };
const mixedCase = {
  companyId: "879E8662-6A94-4a4f-8CD9-43A1CE72C4EF",
  conversationId: "4F8A2C7E-1b3d-4E5F-8a9b-0C1D2E3F4A5B",
};

const message = {
  messageId: "55555555-5555-4555-8555-555555555555",
  role: "assistant" as const,
  createdAt: "2026-09-11T10:00:00.000Z",
  parts: [
    { kind: "text" as const, text: "Готово.", status: "complete" as const },
  ],
  revision: 3,
};

const window = {
  conversationId: CONVERSATION,
  messages: [message],
  olderCursor: null,
  openPause: null,
};

const published: readonly AssistantPublishedEvent[] = [
  {
    type: "turn.started",
    conversationId: CONVERSATION,
    kind: "chat",
    commandId: COMMAND,
  },
  { type: "message.updated", conversationId: CONVERSATION, message },
  {
    type: "turn.finished",
    kind: "answer",
    commandId: COMMAND,
    status: "interrupted",
    window,
  },
];

describe("assistant event channel contract", () => {
  it("names one channel and one presence key per conversation, from the lowercase ids Postgres returns", () => {
    expect(assistantConversationChannel(address)).toBe(
      `assistant:events:${COMPANY}:${CONVERSATION}`,
    );
    expect(assistantPresenceKey(address)).toBe(
      `assistant:presence:${COMPANY}:${CONVERSATION}`,
    );
  });

  it("maps mixed-case company and conversation ids to the same channel and presence key", () => {
    expect(assistantConversationChannel(mixedCase)).toBe(
      assistantConversationChannel(address),
    );
    expect(assistantPresenceKey(mixedCase)).toBe(assistantPresenceKey(address));
  });

  it("keeps one conversation id in two companies apart", () => {
    const elsewhere = {
      companyId: OTHER_COMPANY,
      conversationId: CONVERSATION,
    };
    expect(assistantConversationChannel(elsewhere)).not.toBe(
      assistantConversationChannel(address),
    );
    expect(assistantPresenceKey(elsewhere)).not.toBe(
      assistantPresenceKey(address),
    );
  });

  it("counts a person's streams under their own key, apart from any conversation", () => {
    expect(assistantStreamSlotsKey("user-1")).toBe("assistant:streams:user-1");
    expect(assistantStreamSlotsKey("user-1")).not.toBe(
      assistantStreamSlotsKey("user-2"),
    );
  });

  it("carries every published event across a channel unchanged", () => {
    for (const event of published) {
      expect(decodeAssistantEvent(encodeAssistantEvent(event))).toEqual(event);
    }
  });

  it("refuses to publish a snapshot, the reserved token stream, or a field the client does not know", () => {
    expect(() =>
      encodeAssistantEvent({ type: "snapshot", window } as never),
    ).toThrow();
    expect(() =>
      encodeAssistantEvent({
        type: "text.delta",
        messageId: message.messageId,
      } as never),
    ).toThrow();
    expect(() =>
      encodeAssistantEvent({
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
        userId: "user-1",
      } as never),
    ).toThrow();
  });

  it("reads nothing from a message that is not JSON, of another version, or of an unknown type", () => {
    expect(decodeAssistantEvent("{not json")).toBeNull();
    expect(
      decodeAssistantEvent(JSON.stringify({ version: 2, event: published[0] })),
    ).toBeNull();
    expect(
      decodeAssistantEvent(
        JSON.stringify({ version: 1, event: { type: "turn.paused" } }),
      ),
    ).toBeNull();
  });
});
