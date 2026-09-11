/**
 * Where the conversation is cut.
 *
 * One rule carries the whole file: the cut lands on a request boundary and
 * nowhere else. A provider refuses a history where a tool call has no result or
 * a result has no call, and a window that could split a pair would be the
 * reconstruction bug this path exists to remove, reintroduced as an off-by-one.
 */
import type { ModelMessage } from "@showzy/assistant-kit";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_HISTORY_TURNS,
  assistantHistoryWindow,
} from "./assistant-kit-history-window.js";

/** One request, shaped as a turn that calls a tool actually is. */
function turn(n: number): ModelMessage[] {
  return [
    { role: "user", content: `запит ${String(n)}` },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call_${String(n)}`,
          toolName: "orders_create",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call_${String(n)}`,
          toolName: "orders_create",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
    { role: "assistant", content: `відповідь ${String(n)}` },
  ];
}

function conversation(turns: number): ModelMessage[] {
  return Array.from({ length: turns }, (_, index) => turn(index + 1)).flat();
}

/** The text of a request, which in this fixture is always a plain string. */
function askedText(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function askedIn(messages: readonly ModelMessage[]): string[] {
  return messages.filter((message) => message.role === "user").map(askedText);
}

/** Every tool call has its result, and every result its call. */
function pairsAreWhole(messages: readonly ModelMessage[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-call") {
        calls.add(part.toolCallId);
      }
      if (part.type === "tool-result") {
        results.add(part.toolCallId);
      }
    }
  }
  return (
    calls.size === results.size && [...calls].every((id) => results.has(id))
  );
}

describe("the history window", () => {
  it("keeps a short conversation whole", () => {
    const messages = conversation(3);

    expect(assistantHistoryWindow(messages)).toEqual(messages);
  });

  it("keeps the newest requests and drops the oldest", () => {
    const windowed = assistantHistoryWindow(conversation(10));

    expect(askedIn(windowed)).toEqual([
      "запит 5",
      "запит 6",
      "запит 7",
      "запит 8",
      "запит 9",
      "запит 10",
    ]);
    expect(ASSISTANT_HISTORY_TURNS).toBe(6);
  });

  /**
   * The invariant. A cut one message later would strand a tool result whose
   * call is gone, and the provider rejects that history outright — which reads
   * as the assistant failing for no visible reason.
   */
  it("never separates a tool call from its result", () => {
    for (let turns = 1; turns <= 12; turns += 1) {
      const windowed = assistantHistoryWindow(conversation(turns));
      expect(pairsAreWhole(windowed), `${String(turns)} turns`).toBe(true);
      expect(windowed[0]?.role, `${String(turns)} turns`).toBe("user");
    }
  });

  it("starts the window at a request, whatever the turn contained", () => {
    const mixed: ModelMessage[] = [
      ...turn(1),
      { role: "user", content: "просто питання" },
      { role: "assistant", content: "просто відповідь" },
      ...turn(2),
    ];

    const windowed = assistantHistoryWindow(mixed, { turns: 2 });

    expect(askedIn(windowed)).toEqual(["просто питання", "запит 2"]);
    expect(windowed[0]?.role).toBe("user");
  });

  /**
   * A single turn that called many tools can exceed the message backstop on its
   * own. Dropping it would leave the model answering a request it cannot see, so
   * the newest turn is kept whatever its size — the backstop drops turns, it
   * does not cut inside one.
   */
  it("keeps the newest request even when it alone exceeds the cap", () => {
    const heavy: ModelMessage[] = [
      ...turn(1),
      { role: "user", content: "великий запит" },
      ...Array.from({ length: 40 }, (_, index): ModelMessage => ({
        role: "assistant",
        content: `крок ${String(index)}`,
      })),
    ];

    const windowed = assistantHistoryWindow(heavy, { messagesMax: 10 });

    expect(askedIn(windowed)).toEqual(["великий запит"]);
    expect(windowed).toHaveLength(41);
  });

  it("sends a history it cannot safely cut whole rather than corrupting it", () => {
    // No user message: nothing here is a safe boundary.
    const orphan: ModelMessage[] = [
      { role: "assistant", content: "одне" },
      { role: "assistant", content: "друге" },
    ];

    expect(assistantHistoryWindow(orphan, { turns: 1 })).toEqual(orphan);
  });

  it("handles an empty history", () => {
    expect(assistantHistoryWindow([])).toEqual([]);
  });
});
