/**
 * The ordering rules, on their own.
 *
 * Every test here is a way the two sources can disagree — a window from a
 * request and an event from the stream, arriving in the wrong order. They are
 * pure functions precisely so these cases can be written as themselves rather
 * than staged through a hook, a fetch and a render.
 */
import { describe, expect, it } from "vitest";

import type { AssistantChatWindow } from "@showzy/validation/assistant-chat";
import type { AssistantStreamEvent } from "@showzy/validation/assistant-events";

import {
  applyAssistantStreamEvent,
  applyAssistantWindow,
  assistantTurnActive,
  initialAssistantThreadState,
  type AssistantThreadState,
} from "./assistant-thread-merge";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COMMAND = "22222222-2222-4222-8222-222222222222";
const OTHER_COMMAND = "99999999-9999-4999-8999-999999999999";
const INTERACTION = "33333333-3333-4333-8333-333333333333";
const REPLY = "44444444-4444-4444-8444-444444444444";

const LATEST = { kind: "latest" } as const;

const OPEN_PAUSE = {
  kind: "choice",
  interactionId: INTERACTION,
  revision: 2,
  status: "open" as const,
  prompt: {
    subject: "Катя",
    options: [{ optionId: "opt-a", label: "Катя Самбука" }],
    optionsTruncated: false,
  },
  expiresAt: "2026-09-09T10:15:00.000Z",
};

function message(options?: {
  readonly text?: string;
  readonly status?: "streaming" | "complete";
  readonly revision?: number;
}) {
  return {
    messageId: REPLY,
    role: "assistant" as const,
    createdAt: "2026-09-09T10:00:00.000Z",
    parts: [
      {
        kind: "text" as const,
        text: options?.text ?? "Готово.",
        status: options?.status ?? ("complete" as const),
      },
    ],
    revision: options?.revision ?? 1,
  };
}

function windowOf(options?: {
  readonly text?: string;
  readonly status?: "streaming" | "complete";
  readonly revision?: number;
  readonly openPause?: AssistantChatWindow["openPause"];
}): AssistantChatWindow {
  return {
    conversationId: CONVERSATION,
    messages: [message(options)],
    olderCursor: null,
    openPause: options?.openPause ?? null,
  };
}

function loaded(window: AssistantChatWindow): AssistantThreadState {
  return applyAssistantWindow(initialAssistantThreadState(), window, LATEST);
}

function finished(
  window: AssistantChatWindow | undefined,
  commandId = COMMAND,
): AssistantStreamEvent {
  return {
    type: "turn.finished",
    kind: "chat",
    commandId,
    status: "done",
    ...(window === undefined ? {} : { window }),
  };
}

describe("a turn's presence, read from the conversation", () => {
  it("is the placeholder the accept stores, not a request in flight", () => {
    expect(assistantTurnActive(loaded(windowOf()).thread)).toBe(false);
    expect(
      assistantTurnActive(loaded(windowOf({ status: "streaming" })).thread),
    ).toBe(true);
  });

  it("is false before anything has been read", () => {
    expect(assistantTurnActive(null)).toBe(false);
  });
});

describe("a message that arrives twice", () => {
  it("takes the higher revision, whichever order the two arrive in", () => {
    const state = loaded(windowOf({ text: "Шукаю", status: "streaming" }));

    const forward = applyAssistantStreamEvent(state, {
      type: "message.updated",
      conversationId: CONVERSATION,
      message: message({ text: "Готово.", revision: 2 }),
    });

    expect(forward.state.thread?.messages[0]?.parts).toEqual([
      { kind: "text", text: "Готово.", status: "complete" },
    ]);
    expect(forward.rereadWindow).toBe(false);
  });

  /**
   * The case the `revision` field was added for: the `202` window carries the
   * placeholder, and a `message.updated` that overtook it carries the card. The
   * later write must not be dragged back to the placeholder.
   */
  it("ignores a revision lower than the copy it holds", () => {
    const state = loaded(windowOf({ text: "Готово.", revision: 4 }));

    const applied = applyAssistantStreamEvent(state, {
      type: "message.updated",
      conversationId: CONVERSATION,
      message: message({ text: "Шукаю", status: "streaming", revision: 3 }),
    });

    expect(applied.state.thread?.messages[0]?.parts).toEqual([
      { kind: "text", text: "Готово.", status: "complete" },
    ]);
    expect(applied.rereadWindow).toBe(false);
  });

  it("ignores a repeat of the revision it already holds", () => {
    const state = loaded(windowOf({ text: "Готово.", revision: 4 }));

    const applied = applyAssistantStreamEvent(state, {
      type: "message.updated",
      conversationId: CONVERSATION,
      message: message({ text: "Інше", revision: 4 }),
    });

    expect(applied.state.thread?.messages[0]?.parts[0]).toMatchObject({
      text: "Готово.",
    });
  });

  /**
   * Where a message goes is the window's answer, not this file's. Appending it
   * would be a guess at the order.
   */
  it("reads the window rather than placing a message it does not hold", () => {
    const state = loaded(windowOf());

    const applied = applyAssistantStreamEvent(state, {
      type: "message.updated",
      conversationId: CONVERSATION,
      message: {
        ...message(),
        messageId: "55555555-5555-4555-8555-555555555555",
      },
    });

    expect(applied.state.thread?.messages).toHaveLength(1);
    expect(applied.rereadWindow).toBe(true);
  });
});

describe("a turn that finished", () => {
  it("takes the window whole for the turn being followed", () => {
    const state = applyAssistantStreamEvent(
      loaded(windowOf({ status: "streaming" })),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;

    const applied = applyAssistantStreamEvent(
      state,
      finished(windowOf({ text: "Яку Катю?", openPause: OPEN_PAUSE })),
    );

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(applied.rereadWindow).toBe(false);
    // Nothing left to follow.
    expect(applied.state.trackedTurn).toBeNull();
  });

  /**
   * The ordering hazard SHO-562 named. The stream subscribes, then reads its
   * snapshot, and hands over whatever arrived in the gap — so a `turn.finished`
   * published *before* that snapshot can be delivered after it. Its `openPause`
   * carries no revision, so nothing about the event itself says it is older.
   *
   * The question here was closed by an abandon on another device, which
   * publishes nothing at all. Applied blindly, this event brings it back.
   */
  it("leaves a pause a newer snapshot closed, and reads the window instead", () => {
    const snapshot = applyAssistantStreamEvent(initialAssistantThreadState(), {
      type: "snapshot",
      window: windowOf({ text: "Готово.", openPause: null }),
    }).state;

    const applied = applyAssistantStreamEvent(
      snapshot,
      finished(windowOf({ text: "Яку Катю?", openPause: OPEN_PAUSE })),
    );

    expect(applied.state.thread?.openPause).toBeNull();
    // Not trusted, so not guessed at either: the window is the authority.
    expect(applied.rereadWindow).toBe(true);
  });

  it("keeps the held pause when the turn is not the one being followed", () => {
    const tracked = applyAssistantStreamEvent(
      loaded(windowOf({ status: "streaming", openPause: OPEN_PAUSE })),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;

    const applied = applyAssistantStreamEvent(
      tracked,
      finished(windowOf({ text: "Інша", openPause: null }), OTHER_COMMAND),
    );

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(applied.rereadWindow).toBe(true);
    // The id is dropped, and by the thread rather than by this event: the
    // window it merged carries no placeholder, so the conversation reports no
    // turn running, and there is nothing left to follow. One fact, one source —
    // holding an id past that would let a much later `turn.finished` claim to be
    // the turn this client was watching. The re-read above is what settles what
    // is actually open.
    expect(applied.state.trackedTurn).toBeNull();
  });

  /**
   * The reconciler ends a turn while acting for no person, so it has no window
   * to send (ADR-0039, SHO-570). Reading that absence as "no open question"
   * would hide a real one.
   */
  it("reads the window when the event carries none", () => {
    const state = loaded(
      windowOf({ status: "streaming", openPause: OPEN_PAUSE }),
    );

    const applied = applyAssistantStreamEvent(state, finished(undefined));

    expect(applied.rereadWindow).toBe(true);
    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
  });
});

describe("a reconnection", () => {
  /**
   * Every connection opens with a snapshot, which is what makes a lost event
   * cost nothing. It has to replace what a client held, including a turn it
   * still thinks is running.
   */
  it("replaces stale state from the snapshot it opens with", () => {
    const stale = applyAssistantStreamEvent(
      loaded(windowOf({ text: "Шукаю", status: "streaming" })),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;
    expect(assistantTurnActive(stale.thread)).toBe(true);

    const applied = applyAssistantStreamEvent(stale, {
      type: "snapshot",
      window: windowOf({ text: "Готово.", revision: 5 }),
    });

    expect(applied.state.thread?.messages[0]?.parts[0]).toMatchObject({
      text: "Готово.",
    });
    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    // The turn it was following is over, and the thread is what says so.
    expect(applied.state.trackedTurn).toBeNull();
    expect(applied.rereadWindow).toBe(false);
  });
});
