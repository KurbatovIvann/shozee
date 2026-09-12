/**
 * How a client joins what it is told into the one thread it shows.
 *
 * There are two sources now, not one: windows that come back from a request,
 * and events that arrive on the stream (ADR-0039). They can overtake each
 * other, so this file is where the order is decided — once, in pure functions,
 * rather than in the hook that happens to receive each of them.
 *
 * Three rules carry the weight, and each exists because of a specific way the
 * two sources can disagree.
 *
 * 1. **A message is replaced only by a higher `revision`.** The `202` window
 *    and a `message.updated` that overtook it are two copies of one message;
 *    the server counts writes, so the higher count is the later one. Without
 *    this the accept's placeholder overwrites a card that had already arrived.
 *
 * 2. **`openPause` is taken only from a window this client can vouch for.** It
 *    sits on the window and carries no revision, so it cannot be ordered the
 *    way messages can. The stream subscribes, *then* reads its snapshot, and
 *    delivers whatever arrived in the gap afterwards — so a `turn.finished`
 *    published before a newer snapshot can be handed over after it. Applied
 *    blindly it reopens a question that is already closed: an abandon from
 *    another device closes one and publishes nothing, so no later event
 *    corrects it.
 *
 * 3. **When this client cannot vouch for what it holds, it re-reads.** That is
 *    the single answer to every case below where the truth is not derivable
 *    here — a `turn.finished` with no window at all, one for a turn this client
 *    was not following, and a `message.updated` for a message it does not hold.
 *    `GET /assistant/kit/messages` is the authority on all three. Re-reading is
 *    not polling: it is caused by an event, and nothing asks on a timer.
 *
 * Nothing here invents a message, a part or a pause. Every value shown came
 * from the server.
 */
import {
  mergeAssistantChatWindow,
  type AssistantChatMessage,
  type AssistantChatTextStatus,
  type AssistantChatThread,
  type AssistantChatWindow,
  type AssistantChatWindowSource,
} from "@showzy/validation/assistant-chat";
import type { AssistantStreamEvent } from "@showzy/validation/assistant-events";

const LATEST: AssistantChatWindowSource = { kind: "latest" };

/**
 * The thread, plus which turn this client is following.
 *
 * `trackedTurn` is the `commandId` of the turn currently believed to be
 * running. It is not a second opinion about *whether* one is running — that is
 * the thread's own answer (`assistantTurnActive`) and the only one. It records
 * *which*, so a `turn.finished` can be recognised as the end of the turn this
 * client was watching rather than news about some other one.
 */
export type AssistantThreadState = {
  readonly thread: AssistantChatThread | null;
  readonly trackedTurn: string | null;
  readonly finishedTurns: readonly string[];
  readonly closedPauses: readonly AssistantClosedPause[];
};

export type AssistantClosedPause = {
  readonly interactionId: string;
  readonly revision: number;
};

const ENDINGS_REMEMBERED = 8;

export function initialAssistantThreadState(): AssistantThreadState {
  return {
    thread: null,
    trackedTurn: null,
    finishedTurns: [],
    closedPauses: [],
  };
}

export function assistantPauseAnswered(
  state: AssistantThreadState,
  answered: AssistantClosedPause,
): AssistantThreadState {
  return {
    ...state,
    closedPauses: rememberClosed(state.closedPauses, answered),
  };
}

function rememberFinished(
  finished: readonly string[],
  commandId: string,
): readonly string[] {
  return [commandId, ...finished.filter((id) => id !== commandId)].slice(
    0,
    ENDINGS_REMEMBERED,
  );
}

function rememberClosed(
  closed: readonly AssistantClosedPause[],
  pause: AssistantClosedPause,
): readonly AssistantClosedPause[] {
  const held = closed.find(
    (entry) => entry.interactionId === pause.interactionId,
  );
  const latest =
    held !== undefined && held.revision > pause.revision ? held : pause;
  return [
    latest,
    ...closed.filter((entry) => entry.interactionId !== pause.interactionId),
  ].slice(0, ENDINGS_REMEMBERED);
}

export function assistantTurnActive(
  thread: AssistantChatThread | null,
): boolean {
  return thread !== null && thread.turn !== null;
}

export function assistantTextPartStatus(
  turn: AssistantChatThread["turn"] | null,
  status: AssistantChatTextStatus,
): AssistantChatTextStatus {
  return status === "streaming" && turn === null ? "interrupted" : status;
}

/**
 * A window that came back from a request — a read, a turn, or a refusal.
 */
export function applyAssistantWindow(
  state: AssistantThreadState,
  window: AssistantChatWindow,
  source: AssistantChatWindowSource,
): AssistantApplied {
  const vouched = vouchedWindow(state, window);
  const thread = mergeAssistantChatWindow(state.thread, vouched.window, source);
  return {
    state: settleTracked({ ...state, thread }),
    rereadWindow: vouched.rereadWindow,
  };
}

type VouchedWindow = {
  readonly window: AssistantChatWindow;
  readonly rereadWindow: boolean;
};

function vouchedWindow(
  state: AssistantThreadState,
  window: AssistantChatWindow,
): VouchedWindow {
  const restoresFinishedTurn =
    window.turn !== null && state.finishedTurns.includes(window.turn.id);
  const reopensClosedPause = reopensClosed(
    state.closedPauses,
    window.openPause,
  );
  if (!restoresFinishedTurn && !reopensClosedPause) {
    return { window, rereadWindow: false };
  }
  const held = state.thread;
  return {
    window: {
      ...withHeldPause(held, window),
      turn: restoresFinishedTurn
        ? turnStillRunning(held, state.finishedTurns)
        : window.turn,
    },
    rereadWindow: true,
  };
}

function reopensClosed(
  closed: readonly AssistantClosedPause[],
  openPause: AssistantChatWindow["openPause"],
): boolean {
  return (
    openPause !== null &&
    closed.some(
      (entry) =>
        entry.interactionId === openPause.interactionId &&
        openPause.revision <= entry.revision,
    )
  );
}

function withHeldPause(
  held: AssistantChatThread | null,
  window: AssistantChatWindow,
): AssistantChatWindow {
  return held === null ? window : { ...window, openPause: held.openPause };
}

function turnStillRunning(
  held: AssistantChatThread | null,
  finished: readonly string[],
): AssistantChatWindow["turn"] {
  const turn = held?.turn ?? null;
  return turn === null || finished.includes(turn.id) ? null : turn;
}

function withPauseSeenClosed(
  before: AssistantThreadState,
  applied: AssistantApplied,
): AssistantApplied {
  const closed = before.thread?.openPause ?? null;
  if (closed === null) {
    return applied;
  }
  const open = applied.state.thread?.openPause ?? null;
  if (
    open !== null &&
    open.interactionId === closed.interactionId &&
    open.revision >= closed.revision
  ) {
    return applied;
  }
  return {
    ...applied,
    state: assistantPauseAnswered(applied.state, {
      interactionId: closed.interactionId,
      revision: closed.revision,
    }),
  };
}

export type AssistantApplied = {
  readonly state: AssistantThreadState;
  /**
   * This event left the client holding something it cannot vouch for, and the
   * window must be read again. The caller re-reads once — see rule 3 above.
   */
  readonly rereadWindow: boolean;
};

/**
 * Whether an event is about some other conversation than the one being read.
 *
 * Compared against the id this client **asked for**, never against the one the
 * thread happens to hold. A thread-based check is blind in exactly the window
 * where a stream is most likely to deliver its first event — before any window
 * has landed — and a guard that stops one step short of the thing it guards is
 * the shape that quietly becomes a defect.
 *
 * **The server is the real boundary.** A stream is subscribed only after the
 * author-rule read, under the verified session and company header; that is the
 * authorization, and this is not it. This is defense in depth for invariant 1,
 * because the cost of being wrong here is severe and silent:
 * `mergeAssistantChatWindow`'s latest branch replaces the thread **wholesale**
 * when the ids differ, so a future caller that reused one stream across
 * conversations would swap one thread for another with nothing to show for it.
 * A guard that lives only in the transport is one a later refactor removes
 * without noticing.
 */
function elsewhere(requested: string, conversationId: string): boolean {
  return requested !== conversationId;
}

const UNCHANGED = (state: AssistantThreadState): AssistantApplied => ({
  state,
  rereadWindow: false,
});

export function applyAssistantStreamEvent(
  state: AssistantThreadState,
  event: AssistantStreamEvent,
  /** The conversation this client asked for — see `elsewhere`. */
  conversationId: string,
): AssistantApplied {
  switch (event.type) {
    case "snapshot":
      // Every connection opens with one, and it is read as the conversation
      // now stands — the same standing as any window a request answers with.
      return elsewhere(conversationId, event.window.conversationId)
        ? UNCHANGED(state)
        : withPauseSeenClosed(
            state,
            applyAssistantWindow(state, event.window, LATEST),
          );

    case "turn.started":
      // Which turn is running. Whether one is remains the thread's answer.
      return elsewhere(conversationId, event.conversationId)
        ? UNCHANGED(state)
        : {
            state: { ...state, trackedTurn: event.commandId },
            rereadWindow: false,
          };

    case "message.updated":
      return elsewhere(conversationId, event.conversationId)
        ? UNCHANGED(state)
        : applyMessageUpdated(state, event.message);

    case "turn.finished":
      // The event carries no `conversationId` of its own; its window does. One
      // without a window says only that some turn ended, and all it can cause
      // is a re-read of *this* client's own conversation, which is harmless.
      return event.window !== undefined &&
        elsewhere(conversationId, event.window.conversationId)
        ? UNCHANGED(state)
        : applyTurnFinished(state, event);
  }
}

function applyMessageUpdated(
  state: AssistantThreadState,
  message: AssistantChatMessage,
): AssistantApplied {
  const thread = state.thread;
  if (thread === null) {
    // Nothing to put it in, and where it belongs is not derivable from one
    // message. The window says.
    return { state, rereadWindow: true };
  }
  const at = thread.messages.findIndex(
    (held) => held.messageId === message.messageId,
  );
  if (at === -1) {
    // A message this thread does not hold. Appending it would be a guess at
    // where it goes, and this file guesses at nothing: the window knows the
    // order, so read it rather than invent one.
    return { state, rereadWindow: true };
  }
  const held = thread.messages[at];
  if (held === undefined || held.revision >= message.revision) {
    // Already holding this write or a later one. An event that overtook a
    // window must not drag the message back to an earlier version.
    return { state, rereadWindow: false };
  }
  const messages = [...thread.messages];
  messages[at] = message;
  return {
    // Only the messages change: a `message.updated` says nothing about which
    // question is answerable, so `openPause` is left exactly as it was.
    state: { ...state, thread: { ...thread, messages } },
    rereadWindow: false,
  };
}

function applyTurnFinished(
  state: AssistantThreadState,
  event: Extract<AssistantStreamEvent, { type: "turn.finished" }>,
): AssistantApplied {
  const tracked = state.trackedTurn === event.commandId;
  // Whatever else this event is, the turn it names has ended, so it is no
  // longer the one being followed.
  const cleared = tracked ? null : state.trackedTurn;

  if (event.window === undefined) {
    // The reconciler ended this turn. It acts for no person, and a conversation
    // is read as the person whose conversation it is, so it has no window to
    // send (ADR-0039, SHO-570). The absence says nothing about the open
    // question — reading it as "no question" would hide a real one — so the
    // client goes and reads the window itself.
    return {
      state: {
        ...state,
        trackedTurn: cleared,
        finishedTurns: rememberFinished(state.finishedTurns, event.commandId),
      },
      rereadWindow: true,
    };
  }

  if (!tracked) {
    // A turn this client was not following: it connected mid-turn and never saw
    // the `turn.started`, or this event was held in the subscribe-then-snapshot
    // gap and is older than what is already shown. Its messages are still the
    // server's own and merge safely by revision, but its `openPause` cannot be
    // ordered against the one held, so the held one stands and the window is
    // read again to settle it.
    return {
      ...applyAssistantWindow(
        {
          ...state,
          trackedTurn: cleared,
          finishedTurns: rememberFinished(state.finishedTurns, event.commandId),
        },
        withHeldPause(state.thread, event.window),
        LATEST,
      ),
      rereadWindow: true,
    };
  }

  // The turn this client was following, ending now. Its window is the newest
  // thing anyone has said about this conversation, `openPause` included.
  return withPauseSeenClosed(
    state,
    applyAssistantWindow(
      {
        ...state,
        trackedTurn: null,
        finishedTurns: rememberFinished(state.finishedTurns, event.commandId),
      },
      event.window,
      LATEST,
    ),
  );
}

/**
 * Keep `trackedTurn` from outliving the turn it names.
 *
 * One fact, one source: the thread says whether a turn is running, so when it
 * says none is, there is nothing to track.
 */
function settleTracked(state: AssistantThreadState): AssistantThreadState {
  if (state.trackedTurn === null || assistantTurnActive(state.thread)) {
    return state;
  }
  return { ...state, trackedTurn: null };
}
