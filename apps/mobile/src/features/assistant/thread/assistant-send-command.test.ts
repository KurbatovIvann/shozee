import { describe, expect, it } from "vitest";

import { assistantSendCommand } from "./assistant-send-command";

const INTERACTION = "33333333-3333-4333-8333-333333333333";

const OPEN_PAUSE = {
  kind: "choice",
  interactionId: INTERACTION,
  revision: 2,
  status: "open",
  prompt: {
    subject: "Катя",
    options: [{ optionId: "opt-a", label: "Катя Самбука" }],
    optionsTruncated: false,
  },
  expiresAt: "2026-09-09T10:15:00.000Z",
} as const;

describe("assistantSendCommand", () => {
  it("answers the open card the composer showed", () => {
    const command = assistantSendCommand({
      text: "перша",
      openPause: OPEN_PAUSE,
    });

    expect(command.answering).toEqual({
      interactionId: INTERACTION,
      revision: 2,
    });
  });

  it("carries no reference when no card is open", () => {
    expect(
      assistantSendCommand({ text: "перша", openPause: null }).answering,
    ).toBeNull();
  });

  it("makes the same words against the same card the same attempt", () => {
    const first = assistantSendCommand({
      text: "перша",
      openPause: OPEN_PAUSE,
    });
    const retry = assistantSendCommand({
      text: "перша",
      openPause: OPEN_PAUSE,
    });

    expect(retry.key).toBe(first.key);
  });

  it("makes the same words against a newer revision a different attempt", () => {
    const first = assistantSendCommand({
      text: "перша",
      openPause: OPEN_PAUSE,
    });
    const after = assistantSendCommand({
      text: "перша",
      openPause: { ...OPEN_PAUSE, revision: 3 },
    });

    expect(after.key).not.toBe(first.key);
  });

  it("separates answering a card from superseding it", () => {
    expect(
      assistantSendCommand({ text: "перша", openPause: OPEN_PAUSE }).key,
    ).not.toBe(assistantSendCommand({ text: "перша", openPause: null }).key);
  });
});
