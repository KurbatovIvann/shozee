import { describe, expect, it } from "vitest";

import { readAssistantChatWindow } from "./assistant-window.js";

const SCOPE = {
  conversationId: "4f8a2c7e-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
  bind: "owner",
};

const TURN = { id: "9e8d7c6b-5a49-4382-b716-a5f4e3d2c1b0", status: "queued" };

describe("readAssistantChatWindow", () => {
  it("reads the turn only after the messages, so the turn is never older than them", async () => {
    const reads: string[] = [];
    let settleMessages = (): void => undefined;

    const reading = readAssistantChatWindow(
      {
        messages: {
          read: () =>
            new Promise((resolve) => {
              reads.push("messages");
              settleMessages = () => {
                reads.push("messages settled");
                resolve({
                  conversationId: SCOPE.conversationId,
                  messages: [],
                  olderCursor: null,
                  openPause: null,
                });
              };
            }),
        },
      },
      {
        activeTurn: () => {
          reads.push("turn");
          return Promise.resolve({ id: TURN.id, status: "queued" as const });
        },
      },
      SCOPE,
    );

    await Promise.resolve();
    expect(reads).toEqual(["messages"]);

    settleMessages();
    const window = await reading;

    expect(reads).toEqual(["messages", "messages settled", "turn"]);
    expect(window.turn).toEqual(TURN);
  });
});
