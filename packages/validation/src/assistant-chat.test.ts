/**
 * The client half of paging a conversation.
 *
 * The property that matters most is the last merge test: in whatever order
 * windows arrive, a client that merges each one and then pages back to the
 * start holds exactly the server's log. That is what makes the merge a copy of
 * the log rather than a second derivation of it.
 */
import { describe, expect, it } from "vitest";

import {
  mergeAssistantChatWindow,
  parseAssistantChatWindow,
  type AssistantChatMessage,
  type AssistantChatThread,
  type AssistantChatWindow,
  type AssistantPause,
} from "./assistant-chat.js";

const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const OTHER_CONVERSATION = "44444444-4444-4444-8444-444444444444";
const LATEST = { kind: "latest" } as const;

function message(n: number): AssistantChatMessage {
  return {
    messageId: `77777777-7777-4777-8777-${n.toString(16).padStart(12, "0")}`,
    role: n % 2 === 1 ? "user" : "assistant",
    createdAt: "2026-09-10T10:00:00.000Z",
    parts: [{ kind: "text", text: `message ${String(n)}`, status: "complete" }],
  };
}

/** A server's log of `length` messages, numbered from one. */
function log(length: number): AssistantChatMessage[] {
  return Array.from({ length }, (_, index) => message(index + 1));
}

/**
 * What a server answers: the latest `size` messages, or the `size` before
 * message `before`. A message's number stands in for its sequence number.
 */
function windowOf(
  stored: readonly AssistantChatMessage[],
  size: number,
  before?: number,
): AssistantChatWindow {
  const end = before === undefined ? stored.length : before - 1;
  const start = Math.max(0, end - size);
  return {
    conversationId: CONVERSATION,
    messages: stored.slice(start, end),
    olderCursor: start > 0 ? String(start + 1) : null,
    openPause: null,
  };
}

function numbers(window: AssistantChatWindow | null): number[] {
  return (window?.messages ?? []).map((entry) =>
    Number.parseInt(entry.messageId.slice(-12), 16),
  );
}

function olderPage(
  stored: readonly AssistantChatMessage[],
  size: number,
  held: AssistantChatThread | null,
): AssistantChatThread | null {
  const cursor = held?.olderCursor ?? null;
  if (cursor === null) {
    return held;
  }
  return mergeAssistantChatWindow(
    held,
    windowOf(stored, size, Number(cursor)),
    { kind: "older", cursor },
  );
}

const PAUSE: AssistantPause = {
  kind: "choice",
  interactionId: "55555555-5555-4555-8555-555555555555",
  revision: 1,
  status: "open",
  prompt: {},
  expiresAt: "2026-09-10T10:15:00.000Z",
};

describe("mergeAssistantChatWindow", () => {
  it("takes the first window as it is", () => {
    const merged = mergeAssistantChatWindow(null, windowOf(log(5), 3), LATEST);

    expect(numbers(merged)).toEqual([3, 4, 5]);
    expect(merged?.olderCursor).toBe("3");
  });

  it("joins a later window onto what is held, and keeps the pages loaded before it", () => {
    let held = mergeAssistantChatWindow(null, windowOf(log(5), 3), LATEST);
    held = olderPage(log(5), 3, held);
    expect(numbers(held)).toEqual([1, 2, 3, 4, 5]);

    held = mergeAssistantChatWindow(held, windowOf(log(7), 3), LATEST);

    expect(numbers(held)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(held?.olderCursor).toBeNull();
  });

  it("drops the pages it held when the new window does not reach back to them", () => {
    let held = mergeAssistantChatWindow(null, windowOf(log(5), 3), LATEST);
    held = olderPage(log(5), 3, held);

    held = mergeAssistantChatWindow(held, windowOf(log(12), 3), LATEST);

    expect(numbers(held)).toEqual([10, 11, 12]);
    expect(held?.olderCursor).toBe("10");
  });

  it("takes the open question from the latest window, and keeps it through an older page", () => {
    let held = mergeAssistantChatWindow(
      null,
      { ...windowOf(log(5), 3), openPause: PAUSE },
      LATEST,
    );
    held = olderPage(log(5), 3, held);
    expect(held?.openPause).toEqual(PAUSE);

    held = mergeAssistantChatWindow(held, windowOf(log(6), 3), LATEST);
    expect(held?.openPause).toBeNull();
  });

  it("puts an older page in front only when it starts where the thread does", () => {
    const held = mergeAssistantChatWindow(null, windowOf(log(9), 3), LATEST);

    const stale = mergeAssistantChatWindow(held, windowOf(log(9), 3, 4), {
      kind: "older",
      cursor: "4",
    });

    expect(stale).toBe(held);
  });

  it("puts nothing from another conversation in front, and starts over for its latest window", () => {
    const held = mergeAssistantChatWindow(null, windowOf(log(9), 3), LATEST);
    const foreign = {
      ...windowOf(log(6), 3, 7),
      conversationId: OTHER_CONVERSATION,
    };

    expect(
      mergeAssistantChatWindow(held, foreign, { kind: "older", cursor: "7" }),
    ).toBe(held);
    expect(mergeAssistantChatWindow(held, foreign, LATEST)).toBe(foreign);
  });

  it("takes an empty latest window as it is", () => {
    const held = mergeAssistantChatWindow(null, windowOf(log(4), 3), LATEST);
    const empty = windowOf([], 3);

    expect(mergeAssistantChatWindow(held, empty, LATEST)).toBe(empty);
  });

  it("holds exactly the server's log, in whatever order windows arrive", () => {
    let seed = 20_260_910;
    const random = (limit: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };

    // One window smaller than a request, one realistic for a test, one real.
    for (const size of [1, 3, 30]) {
      const stored = log(1 + random(5));
      let held = mergeAssistantChatWindow(null, windowOf(stored, size), LATEST);

      for (let step = 0; step < 300; step += 1) {
        const action = random(4);
        if (action === 0 && (held?.olderCursor ?? null) !== null) {
          held = olderPage(stored, size, held);
        } else {
          // A request here adds one or two messages; another device, many.
          const added = action === 3 ? random(3 * size) : 1 + random(2);
          for (let n = 0; n < added; n += 1) {
            stored.push(message(stored.length + 1));
          }
          held = mergeAssistantChatWindow(held, windowOf(stored, size), LATEST);
        }

        // Always an unbroken run that ends at the server's latest message, and
        // a cursor exactly when that run does not start at the first.
        const shown = numbers(held);
        expect(shown).toEqual(
          Array.from(
            { length: shown.length },
            (_, index) => stored.length - shown.length + index + 1,
          ),
        );
        expect((held?.olderCursor ?? null) === null).toBe(shown[0] === 1);
      }

      while ((held?.olderCursor ?? null) !== null) {
        held = olderPage(stored, size, held);
      }
      expect(numbers(held)).toEqual(stored.map((_, index) => index + 1));
    }
  });
});

describe("parseAssistantChatWindow", () => {
  const readable = windowOf(log(2), 30);

  it("reads a window the strict schema reads, unchanged", () => {
    expect(parseAssistantChatWindow(readable)).toEqual(readable);
  });

  it("leaves out a message this build cannot read, and keeps the rest", () => {
    const parsed = parseAssistantChatWindow({
      ...readable,
      messages: [
        { ...message(1), parts: [{ kind: "voice", clipId: "clip-1" }] },
        message(2),
      ],
    });

    expect(numbers(parsed)).toEqual([2]);
  });

  it("reads past an envelope field it does not know yet", () => {
    expect(parseAssistantChatWindow({ ...readable, newerCursor: "9" })).toEqual(
      readable,
    );
  });

  it("is null for something that is not a window", () => {
    for (const value of [
      null,
      "window",
      { messages: "nope" },
      { ...readable, olderCursor: 3 },
    ]) {
      expect(parseAssistantChatWindow(value)).toBeNull();
    }
  });
});
