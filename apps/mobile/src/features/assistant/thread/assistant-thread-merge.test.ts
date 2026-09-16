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
  applyAssistantReread,
  applyAssistantStreamEvent,
  applyAssistantWindow,
  assistantPauseAnswered,
  assistantTurnActive,
  initialAssistantThreadState,
  type AssistantThreadState,
} from "./assistant-thread-merge";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const COMMAND = "22222222-2222-4222-8222-222222222222";
const OTHER_COMMAND = "99999999-9999-4999-8999-999999999999";
const INTERACTION = "33333333-3333-4333-8333-333333333333";
const REPLY = "44444444-4444-4444-8444-444444444444";

function turnId(n: number): string {
  return `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
}

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
  readonly turn?: AssistantChatWindow["turn"];
  readonly interruptedTurn?: AssistantChatWindow["interruptedTurn"];
}): AssistantChatWindow {
  return {
    conversationId: CONVERSATION,
    messages: [message(options)],
    olderCursor: null,
    openPause: options?.openPause ?? null,
    turn: options?.turn ?? null,
    interruptedTurn: options?.interruptedTurn ?? null,
  };
}

function loaded(window: AssistantChatWindow): AssistantThreadState {
  return applyAssistantWindow(initialAssistantThreadState(), window, LATEST)
    .state;
}

/**
 * Every event is for the conversation this client asked for, unless a test
 * says otherwise by passing a different `requested`.
 */
function apply(
  state: AssistantThreadState,
  event: AssistantStreamEvent,
  requested: string = CONVERSATION,
) {
  return applyAssistantStreamEvent(state, event, requested);
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
    endReason: null,
    ...(window === undefined ? {} : { window }),
  };
}

describe("a turn's presence, read from the window's own turn field", () => {
  it("reports a running turn", () => {
    expect(
      assistantTurnActive(
        loaded(
          windowOf({
            status: "streaming",
            turn: { id: COMMAND, status: "running" },
          }),
        ).thread,
      ),
    ).toBe(true);
  });

  it("reports none once the turn has ended", () => {
    expect(assistantTurnActive(loaded(windowOf()).thread)).toBe(false);
  });

  it("reports none for a turn the reconciler ended for a removed author, even with a streaming placeholder still stored", () => {
    expect(
      assistantTurnActive(loaded(windowOf({ status: "streaming" })).thread),
    ).toBe(false);
  });

  it("is false before anything has been read", () => {
    expect(assistantTurnActive(null)).toBe(false);
  });
});

describe("a message that arrives twice", () => {
  it("takes the higher revision, whichever order the two arrive in", () => {
    const state = loaded(windowOf({ text: "Шукаю", status: "streaming" }));

    const forward = apply(state, {
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

    const applied = apply(state, {
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

    const applied = apply(state, {
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

    const applied = apply(state, {
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
    const state = apply(loaded(windowOf({ status: "streaming" })), {
      type: "turn.started",
      conversationId: CONVERSATION,
      kind: "chat",
      commandId: COMMAND,
    }).state;

    const applied = apply(
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
    const snapshot = apply(initialAssistantThreadState(), {
      type: "snapshot",
      window: windowOf({ text: "Готово.", openPause: null }),
    }).state;

    const applied = apply(
      snapshot,
      finished(windowOf({ text: "Яку Катю?", openPause: OPEN_PAUSE })),
    );

    expect(applied.state.thread?.openPause).toBeNull();
    // Not trusted, so not guessed at either: the window is the authority.
    expect(applied.rereadWindow).toBe(true);
  });

  it("keeps the held pause when the turn is not the one being followed", () => {
    const tracked = apply(
      loaded(windowOf({ status: "streaming", openPause: OPEN_PAUSE })),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;

    const applied = apply(
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

    const applied = apply(state, finished(undefined));

    expect(applied.rereadWindow).toBe(true);
    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
  });
});

/**
 * Defense in depth for invariant 1. Unreachable through today's transport, and
 * that is the point: `mergeAssistantChatWindow`'s latest branch replaces the
 * thread wholesale when the ids differ, so the day a caller reuses one stream
 * across conversations, the failure is a silently swapped thread.
 */
describe("an event about another conversation", () => {
  const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("is ignored rather than swapping the thread", () => {
    const state = loaded(windowOf({ text: "Наше" }));
    const ours = { text: "Наше" };

    const snapshot = apply(state, {
      type: "snapshot",
      window: { ...windowOf({ text: "Чуже" }), conversationId: OTHER },
    });
    expect(snapshot.state.thread?.messages[0]?.parts[0]).toMatchObject(ours);

    const updated = apply(state, {
      type: "message.updated",
      conversationId: OTHER,
      message: message({ text: "Чуже", revision: 9 }),
    });
    expect(updated.state.thread?.messages[0]?.parts[0]).toMatchObject(ours);
    // Not ours to re-read for, either.
    expect(updated.rereadWindow).toBe(false);

    const started = apply(state, {
      type: "turn.started",
      conversationId: OTHER,
      kind: "chat",
      commandId: COMMAND,
    });
    expect(started.state.trackedTurn).toBeNull();

    const ended = apply(state, {
      type: "turn.finished",
      kind: "chat",
      commandId: COMMAND,
      status: "done",
      endReason: null,
      window: {
        ...windowOf({ text: "Чуже", openPause: OPEN_PAUSE }),
        conversationId: OTHER,
      },
    });
    expect(ended.state.thread?.messages[0]?.parts[0]).toMatchObject(ours);
    expect(ended.state.thread?.openPause).toBeNull();
    expect(ended.rereadWindow).toBe(false);
  });

  /**
   * The hole a thread-based check leaves open, and the reason the comparison is
   * against the requested id: before the first window lands there is no thread
   * to disagree with, which is exactly when a freshly opened stream delivers
   * its snapshot.
   */
  it("is ignored even before the first window has landed", () => {
    const applied = apply(initialAssistantThreadState(), {
      type: "snapshot",
      window: { ...windowOf({ text: "Перше" }), conversationId: OTHER },
    });

    expect(applied.state.thread).toBeNull();
  });

  it("still accepts the first window of the conversation that was asked for", () => {
    const applied = apply(initialAssistantThreadState(), {
      type: "snapshot",
      window: windowOf({ text: "Перше" }),
    });

    expect(applied.state.thread?.conversationId).toBe(CONVERSATION);
  });
});

describe("a reconnection", () => {
  /**
   * Every connection opens with a snapshot, which is what makes a lost event
   * cost nothing. It has to replace what a client held, including a turn it
   * still thinks is running.
   */
  it("replaces stale state from the snapshot it opens with", () => {
    const stale = apply(
      loaded(
        windowOf({
          text: "Шукаю",
          status: "streaming",
          turn: { id: COMMAND, status: "running" },
        }),
      ),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;
    expect(assistantTurnActive(stale.thread)).toBe(true);

    const applied = apply(stale, {
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

describe("a window that resolved after the thread moved past it", () => {
  function ended(window: AssistantChatWindow): AssistantThreadState {
    const started = apply(
      loaded(
        windowOf({
          status: "streaming",
          turn: { id: COMMAND, status: "running" },
        }),
      ),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;
    return apply(started, finished(window)).state;
  }

  const late = windowOf({
    text: "",
    status: "streaming",
    turn: { id: COMMAND, status: "running" },
  });

  it("keeps the finished reply rather than the placeholder the window carries", () => {
    const applied = applyAssistantWindow(
      ended(windowOf({ text: "Готово.", revision: 4 })),
      late,
      LATEST,
    );

    expect(applied.state.thread?.messages[0]?.parts).toEqual([
      { kind: "text", text: "Готово.", status: "complete" },
    ]);
  });

  it("does not bring back a turn it has seen finish, and reads the window", () => {
    const applied = applyAssistantWindow(
      ended(windowOf({ text: "Готово.", revision: 4 })),
      late,
      LATEST,
    );

    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    expect(applied.rereadWindow).toBe(true);
  });

  it("keeps a question opened since, when it refuses that window's turn", () => {
    const state = ended(
      windowOf({
        text: "Яку Катю?",
        revision: 4,
        openPause: OPEN_PAUSE,
      }),
    );
    expect(state.thread?.openPause?.interactionId).toBe(INTERACTION);

    const applied = applyAssistantWindow(state, late, LATEST);

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(assistantTurnActive(applied.state.thread)).toBe(false);
  });

  function closedByTheTurnItWatched(): AssistantThreadState {
    const asked = apply(
      loaded(
        windowOf({
          openPause: OPEN_PAUSE,
          turn: { id: COMMAND, status: "running" },
        }),
      ),
      {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: COMMAND,
      },
    ).state;
    return apply(asked, finished(windowOf({ text: "Готово.", revision: 4 })))
      .state;
  }

  it("does not reopen a question the turn it watched ended without", () => {
    const closed = closedByTheTurnItWatched();
    expect(closed.thread?.openPause).toBeNull();

    const applied = applyAssistantWindow(
      closed,
      windowOf({ openPause: OPEN_PAUSE }),
      LATEST,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });

  it("takes a higher revision of the question it saw closed", () => {
    const applied = applyAssistantWindow(
      closedByTheTurnItWatched(),
      windowOf({
        revision: 5,
        openPause: { ...OPEN_PAUSE, revision: OPEN_PAUSE.revision + 1 },
      }),
      LATEST,
    );

    expect(applied.state.thread?.openPause?.revision).toBe(
      OPEN_PAUSE.revision + 1,
    );
    expect(applied.rereadWindow).toBe(false);
  });

  it("does not reopen a question from a window older than the snapshot that closed it", () => {
    const asked = loaded(windowOf({ openPause: OPEN_PAUSE }));

    const snapshot = apply(asked, {
      type: "snapshot",
      window: windowOf({ text: "Готово.", revision: 4 }),
    }).state;
    const applied = applyAssistantWindow(
      snapshot,
      windowOf({ openPause: OPEN_PAUSE }),
      LATEST,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });

  it("does not bring back a turn a reconnect snapshot showed ended, and reads the window", () => {
    const following = apply(initialAssistantThreadState(), {
      type: "turn.started",
      conversationId: CONVERSATION,
      kind: "chat",
      commandId: COMMAND,
    }).state;
    const snapshot = apply(following, {
      type: "snapshot",
      window: windowOf({ text: "Готово.", revision: 4 }),
    }).state;

    const applied = applyAssistantWindow(
      snapshot,
      windowOf({
        text: "",
        status: "streaming",
        revision: 1,
        turn: { id: COMMAND, status: "queued" },
      }),
      LATEST,
    );

    expect(applied.state.thread?.messages[0]?.revision).toBe(4);
    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    expect(applied.rereadWindow).toBe(true);
  });

  it("keeps every message it holds when an empty snapshot read before them arrives late", () => {
    const held = loaded(windowOf({ text: "Готово.", revision: 4 }));

    const applied = apply(held, {
      type: "snapshot",
      window: { ...windowOf(), messages: [] },
    });

    expect(applied.state.thread?.messages).toEqual(held.thread?.messages);
    expect(applied.rereadWindow).toBe(true);
  });

  it("does not bring back a turn from a window that carries nothing newer than the thread", () => {
    const settled = loaded(windowOf({ text: "Готово.", revision: 4 }));

    const applied = applyAssistantWindow(
      settled,
      windowOf({
        text: "Готово.",
        revision: 4,
        turn: { id: COMMAND, status: "running" },
      }),
      LATEST,
    );

    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    expect(applied.rereadWindow).toBe(true);
  });

  it("takes a new turn whose window brings the message that started it", () => {
    const settled = loaded(windowOf({ text: "Готово.", revision: 4 }));
    const accepted = windowOf({
      text: "Готово.",
      revision: 4,
      turn: { id: OTHER_COMMAND, status: "queued" },
    });

    const applied = applyAssistantWindow(
      settled,
      {
        ...accepted,
        messages: [
          ...accepted.messages,
          { ...message(), messageId: INTERACTION, role: "user" },
        ],
      },
      LATEST,
    );

    expect(assistantTurnActive(applied.state.thread)).toBe(true);
    expect(applied.rereadWindow).toBe(false);
  });

  it("forgets the oldest turn it saw end once nine have ended", () => {
    let state = loaded(windowOf());
    for (let n = 0; n < 9; n += 1) {
      state = apply(state, finished(undefined, turnId(n))).state;
    }

    const oldest = applyAssistantWindow(
      state,
      windowOf({ revision: 2, turn: { id: turnId(0), status: "running" } }),
      LATEST,
    );
    const newest = applyAssistantWindow(
      state,
      windowOf({ revision: 2, turn: { id: turnId(8), status: "running" } }),
      LATEST,
    );

    expect(assistantTurnActive(oldest.state.thread)).toBe(true);
    expect(oldest.rereadWindow).toBe(false);
    expect(assistantTurnActive(newest.state.thread)).toBe(false);
    expect(newest.rereadWindow).toBe(true);
  });

  it("keeps the higher revision when the same question is recorded twice", () => {
    const closed = assistantPauseAnswered(
      assistantPauseAnswered(loaded(windowOf()), {
        interactionId: INTERACTION,
        revision: 5,
      }),
      { interactionId: INTERACTION, revision: 2 },
    );

    const applied = applyAssistantWindow(
      closed,
      windowOf({ openPause: { ...OPEN_PAUSE, revision: 5 } }),
      LATEST,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });
  it("does not bring back a turn that ended before the last one", () => {
    const first = ended(windowOf({ text: "Готово.", revision: 4 }));
    const second = apply(
      apply(first, {
        type: "turn.started",
        conversationId: CONVERSATION,
        kind: "chat",
        commandId: OTHER_COMMAND,
      }).state,
      finished(windowOf({ text: "Готово.", revision: 5 }), OTHER_COMMAND),
    ).state;

    const applied = applyAssistantWindow(second, late, LATEST);

    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    expect(applied.rereadWindow).toBe(true);
  });

  it("does not reopen a question this client answered itself", () => {
    const asked = loaded(windowOf({ openPause: OPEN_PAUSE }));
    const settled = applyAssistantWindow(
      asked,
      windowOf({ text: "Готово.", revision: 4 }),
      LATEST,
    ).state;
    expect(settled.thread?.openPause).toBeNull();

    const answered = assistantPauseAnswered(settled, {
      interactionId: INTERACTION,
      revision: OPEN_PAUSE.revision,
    });
    const applied = applyAssistantWindow(
      answered,
      windowOf({ openPause: OPEN_PAUSE }),
      LATEST,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });
});

describe("a question closed without a message being written", () => {
  function asked(
    openPause: AssistantChatWindow["openPause"],
  ): AssistantChatWindow {
    const window = windowOf({ text: "Яку Катю?", revision: 4, openPause });
    return {
      ...window,
      messages: window.messages.map((entry) => ({
        ...entry,
        parts: [
          ...entry.parts,
          {
            kind: "interaction" as const,
            interactionId: INTERACTION,
            revision: OPEN_PAUSE.revision,
            pause: OPEN_PAUSE,
          },
        ],
      })),
    };
  }

  function abandonedElsewhere(): AssistantThreadState {
    return applyAssistantWindow(loaded(asked(OPEN_PAUSE)), asked(null), LATEST)
      .state;
  }

  it("does not reopen it from a window that carries nothing newer, and reads the window", () => {
    const applied = applyAssistantWindow(
      abandonedElsewhere(),
      asked(OPEN_PAUSE),
      LATEST,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });

  it("reopens it when a re-read issued after the last window says it is open", () => {
    const state = abandonedElsewhere();

    const applied = applyAssistantReread(
      state,
      asked(OPEN_PAUSE),
      state.windowsApplied,
    );

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(applied.rereadWindow).toBe(false);
  });

  it("keeps the rules for a re-read answered after another window landed", () => {
    const issued = abandonedElsewhere();
    const landed = applyAssistantWindow(issued, asked(null), LATEST).state;

    const applied = applyAssistantReread(
      landed,
      asked(OPEN_PAUSE),
      issued.windowsApplied,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(true);
  });

  it("takes a turn a re-read issued after the last window reports with the same messages", () => {
    const state = loaded(windowOf({ text: "Готово.", revision: 4 }));

    const applied = applyAssistantReread(
      state,
      windowOf({
        text: "Готово.",
        revision: 4,
        turn: { id: COMMAND, status: "running" },
      }),
      state.windowsApplied,
    );

    expect(assistantTurnActive(applied.state.thread)).toBe(true);
    expect(applied.rereadWindow).toBe(false);
  });

  it("takes a question opened before the message that asks it is written", () => {
    const applied = applyAssistantWindow(
      loaded(windowOf({ text: "Готово.", revision: 4 })),
      windowOf({ text: "Готово.", revision: 4, openPause: OPEN_PAUSE }),
      LATEST,
    );

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(applied.rereadWindow).toBe(false);
  });

  it("does not let a settling re-read reopen a question this client answered", () => {
    const state = assistantPauseAnswered(abandonedElsewhere(), {
      interactionId: INTERACTION,
      revision: OPEN_PAUSE.revision,
    });

    const applied = applyAssistantReread(
      state,
      asked(OPEN_PAUSE),
      state.windowsApplied,
    );

    expect(applied.state.thread?.openPause).toBeNull();
    expect(applied.rereadWindow).toBe(false);
  });

  it("takes the turn and question of a settling re-read an event overtook, and keeps the event's message", () => {
    const running = loaded(
      windowOf({
        text: "",
        status: "streaming",
        revision: 1,
        turn: { id: COMMAND, status: "running" },
      }),
    );
    const issuedAfter = running.windowsApplied;
    const carded = apply(running, {
      type: "message.updated",
      conversationId: CONVERSATION,
      message: message({ text: "Картка", revision: 2 }),
    }).state;

    const applied = applyAssistantReread(
      carded,
      windowOf({ text: "", status: "streaming", revision: 1 }),
      issuedAfter,
    );

    expect(applied.state.thread?.messages[0]?.revision).toBe(2);
    expect(assistantTurnActive(applied.state.thread)).toBe(false);
    expect(applied.rereadWindow).toBe(false);
  });

  it("still settles a re-read when an older page landed while it was on its way", () => {
    const state = abandonedElsewhere();
    const issuedAfter = state.windowsApplied;
    const paged = applyAssistantWindow(
      state,
      { ...asked(null), messages: [] },
      { kind: "older", cursor: "1" },
    ).state;

    const applied = applyAssistantReread(paged, asked(OPEN_PAUSE), issuedAfter);

    expect(applied.state.thread?.openPause?.interactionId).toBe(INTERACTION);
    expect(applied.rereadWindow).toBe(false);
  });
});
