import { describe, expect, it } from "vitest";

import {
  ASSISTANT_RESERVED_EVENT_TYPES,
  assistantPublishedEventSchema,
  parseAssistantStreamEvent,
} from "./assistant-events.js";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const COMMAND = "44444444-4444-4444-8444-444444444444";

const message = {
  messageId: "55555555-5555-4555-8555-555555555555",
  role: "assistant",
  createdAt: "2026-09-11T10:00:00.000Z",
  parts: [{ kind: "text", text: "Готово.", status: "complete" }],
  revision: 2,
} as const;

const window = {
  conversationId: CONVERSATION,
  messages: [message],
  olderCursor: null,
  openPause: null,
};

const events = {
  snapshot: { type: "snapshot", window },
  "turn.started": {
    type: "turn.started",
    conversationId: CONVERSATION,
    kind: "chat",
    commandId: COMMAND,
  },
  "message.updated": {
    type: "message.updated",
    conversationId: CONVERSATION,
    message,
  },
  "turn.finished": {
    type: "turn.finished",
    kind: "chat",
    commandId: COMMAND,
    status: "done",
    window,
  },
} as const;

describe("reading an assistant stream event", () => {
  it("reads every event a stream carries, under its own name", () => {
    for (const [name, event] of Object.entries(events)) {
      expect(parseAssistantStreamEvent(name, JSON.stringify(event))).toEqual(
        event,
      );
    }
  });

  it("refuses an event whose SSE name disagrees with its payload", () => {
    expect(
      parseAssistantStreamEvent(
        "turn.finished",
        JSON.stringify(events["turn.started"]),
      ),
    ).toBeNull();
  });

  it("skips the reserved token stream, an unknown name and unreadable data", () => {
    for (const reserved of ASSISTANT_RESERVED_EVENT_TYPES) {
      expect(
        parseAssistantStreamEvent(
          reserved,
          JSON.stringify({ type: reserved, messageId: message.messageId }),
        ),
      ).toBeNull();
    }
    expect(
      parseAssistantStreamEvent(
        "turn.paused",
        JSON.stringify({ type: "turn.paused" }),
      ),
    ).toBeNull();
    expect(parseAssistantStreamEvent("snapshot", "{not json")).toBeNull();
  });

  it("carries a message only with its revision, so a client can keep the newer copy", () => {
    const { revision, ...withoutRevision } = message;
    void revision;
    expect(
      parseAssistantStreamEvent(
        "message.updated",
        JSON.stringify({
          ...events["message.updated"],
          message: withoutRevision,
        }),
      ),
    ).toBeNull();
  });

  /**
   * The reconciler ends a turn the process running it no longer can, and it
   * acts for no person, so it has no window to send (SHO-570). A client reads
   * the conversation itself after one of these.
   */
  it("reads a finish with no window: the reconciler ended that turn", () => {
    const withoutWindow = {
      type: "turn.finished",
      kind: "chat",
      commandId: COMMAND,
      status: "interrupted",
    };

    expect(
      parseAssistantStreamEvent("turn.finished", JSON.stringify(withoutWindow)),
    ).toEqual(withoutWindow);
    expect(assistantPublishedEventSchema.safeParse(withoutWindow).success).toBe(
      true,
    );
    // A window that is there is still a window, not any other shape.
    expect(
      parseAssistantStreamEvent(
        "turn.finished",
        JSON.stringify({ ...withoutWindow, window: { messages: [] } }),
      ),
    ).toBeNull();
  });

  it("never lets a producer publish a snapshot: each connection reads its own", () => {
    expect(
      assistantPublishedEventSchema.safeParse(events.snapshot).success,
    ).toBe(false);
  });
});
