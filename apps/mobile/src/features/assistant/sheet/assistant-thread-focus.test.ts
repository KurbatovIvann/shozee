import { describe, expect, it } from "vitest";

import {
  ASSISTANT_THREAD_FOCUS_START,
  assistantThreadFocus,
} from "./assistant-thread-focus";
import type { AssistantThreadRow } from "../thread/thread-rows";

const INTERACTION = "33333333-3333-4333-8333-333333333333";
const OTHER = "55555555-5555-4555-8555-555555555555";

function row(options?: {
  readonly id?: string;
  readonly interactionId?: string;
  readonly revision?: number;
}): AssistantThreadRow {
  const interactionId = options?.interactionId ?? null;
  return {
    id: options?.id ?? "m1",
    role: "assistant",
    text: "Яку Катю?",
    surfaces: [],
    closures: [],
    interaction:
      interactionId === null
        ? null
        : {
            kind: "choice",
            interactionId,
            revision: options?.revision ?? 2,
            subject: "Катя",
            options: [
              { optionId: "opt-a", label: "Катя Самбука", kind: "record" },
            ],
            optionsTruncated: false,
            nearest: false,
            problem: undefined,
          },
    failed: false,
    interrupted: false,
    interruptedReason: null,
    waiting: false,
  };
}

describe("assistantThreadFocus", () => {
  it("moves to a card that has just opened", () => {
    const next = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m0" }),
      row({ id: "m1", interactionId: INTERACTION }),
    ]);

    expect(next.move).toEqual({ kind: "card", index: 1 });
  });

  it("leaves a card already shown alone", () => {
    const rows = [row({ id: "m1", interactionId: INTERACTION })];
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, rows);

    expect(
      assistantThreadFocus(first.focus, [...rows, row({ id: "m2" })]).move,
    ).toEqual({ kind: "none" });
  });

  it("moves to the next card when the answered one is replaced", () => {
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m1", interactionId: INTERACTION }),
    ]);

    const next = assistantThreadFocus(first.focus, [
      row({ id: "m1" }),
      row({ id: "m2", interactionId: OTHER }),
    ]);

    expect(next.move).toEqual({ kind: "card", index: 1 });
  });

  it("moves to a new revision of the same question", () => {
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m1", interactionId: INTERACTION, revision: 2 }),
    ]);

    const next = assistantThreadFocus(first.focus, [
      row({ id: "m1", interactionId: INTERACTION, revision: 3 }),
    ]);

    expect(next.move).toEqual({ kind: "card", index: 0 });
  });

  it("moves to the composer once the last card closes", () => {
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m1", interactionId: INTERACTION }),
    ]);

    expect(assistantThreadFocus(first.focus, [row({ id: "m1" })]).move).toEqual(
      { kind: "composer" },
    );
  });

  it("leaves the keyboard alone when the thread is cleared", () => {
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m1", interactionId: INTERACTION }),
    ]);

    const cleared = assistantThreadFocus(first.focus, []);

    expect(cleared.move).toEqual({ kind: "none" });
    expect(
      assistantThreadFocus(cleared.focus, [
        row({ id: "m1", interactionId: INTERACTION }),
      ]).move,
    ).toEqual({ kind: "card", index: 0 });
  });

  it("leaves the keyboard alone on a thread that never had a card", () => {
    const first = assistantThreadFocus(ASSISTANT_THREAD_FOCUS_START, [
      row({ id: "m1" }),
    ]);

    expect(first.move).toEqual({ kind: "none" });
    expect(
      assistantThreadFocus(first.focus, [row({ id: "m1" }), row({ id: "m2" })])
        .move,
    ).toEqual({ kind: "none" });
  });
});
