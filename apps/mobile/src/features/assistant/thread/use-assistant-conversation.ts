/**
 * The whole assistant surface, as three pieces of state: the thread, whether a
 * command of this screen's is in flight, and what last went wrong.
 *
 * This replaces `use-assistant-chat` plus `use-assistant-choice` plus
 * `use-assistant-confirmation`. Those held, between them, a set of ignored
 * challenge ids, a set of dismissed ones, a set of resolved ones, a
 * currently-resolving id, an attempted `(challenge, option)` pair and five refs
 * mirroring all of it — because the server kept re-sending questions that had
 * already been answered and could not say whether a tap had been claimed. Every
 * one of those existed to guess at server state. The server now reports it, so
 * they are gone rather than reorganised.
 *
 * The rule that makes it small: every call answers with the conversation as it
 * stands — its latest window — so every outcome is applied the same way. A
 * success and a refusal both carry the window; the refusal additionally has
 * something to say. Windows and stream events join into one thread through
 * `assistant-thread-merge.ts`, which owns every ordering rule.
 *
 * **A turn no longer lives inside a request** (ADR-0039). `/kit/chat` and
 * `/kit/answer` answer `202 accepted` once the turn is stored and queued, and
 * the worker runs it. Two things follow, and they are the shape of this file:
 *
 * - `busy` is the *conversation's* answer, not this screen's. It comes from the
 *   thread's active turn — the `streaming` placeholder the accept stores — so a
 *   turn started on another device reads as busy here, and this phone's request
 *   having returned does not mean the turn is over. `sending` is the separate,
 *   much shorter fact that a command of this screen's is in flight.
 * - The result arrives on the event stream rather than as the reply to the
 *   request that started it. Nothing asks on a timer; see `use-assistant-stream`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assistantInteractionFromPause,
  type AssistantInteraction,
} from "@showzy/validation/assistant-chat";

import type { Locale } from "../../../i18n/locale";
import {
  clipAssistantKitText,
  getAssistantKitWindow,
  postAssistantKitAbandon,
  postAssistantKitAnswer,
  postAssistantKitChat,
  type AssistantKitCall,
  type AssistantKitFailure,
  type AssistantKitFailureKind,
  type AssistantKitOutcome,
} from "../api/assistant-kit-client";
import {
  applyAssistantStreamEvent,
  applyAssistantWindow,
  assistantTurnActive,
  initialAssistantThreadState,
  type AssistantThreadState,
} from "./assistant-thread-merge";
import { useAssistantStream } from "./use-assistant-stream";
import { assistantThreadRows, type AssistantThreadRow } from "./thread-rows";

/**
 * Bumped by the caller when the tenant or the signed-in person changes. A reply
 * that arrives after that belongs to a conversation nobody is looking at, and
 * applying it would show one company's data under another.
 */
export type AssistantTenantEpochRef = { current: number };

/**
 * What became of a send, as far as the screen that made it is concerned.
 *
 * `refused` is the only outcome that gives the words back — the server decided
 * this attempt and accepted nothing, so the composer is where they belong.
 * `unknown` is a fault that may have landed either side of the accept: the
 * words stay on screen as the echo instead of going back into the composer,
 * because the turn may well be running and a composer holding them again is an
 * invitation to send a message the server already has.
 *
 * `superseded` means the tenant or the conversation changed while it was in
 * flight: whatever came back belongs to a thread nobody is looking at, so there
 * is nothing to restore and nothing to report on this one (SHO-552).
 */
export type AssistantSendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "refused"; readonly failure: AssistantKitFailure }
  | { readonly kind: "unknown"; readonly failure: AssistantKitFailure }
  | { readonly kind: "superseded" };

/** A call's failure, and whether the screen that made it is still the one showing. */
type RunResult = {
  readonly failure: AssistantKitFailure | null;
  readonly current: boolean;
};

export interface UseAssistantConversation {
  readonly rows: readonly AssistantThreadRow[];
  /** The open question, if any, with its prompt already parsed. */
  readonly interaction: AssistantInteraction | null;
  /** A turn is running on this conversation — here or on another device. */
  readonly busy: boolean;
  /** A command of this screen's is in flight. Seconds, not the length of a turn. */
  readonly sending: boolean;
  readonly failure: AssistantKitFailure | null;
  /**
   * What became of the send, for the screen that made it — so a caller holding
   * the draft knows whether to put the text back in the field.
   */
  readonly send: (text: string) => Promise<AssistantSendOutcome>;
  /** Answer the open question. The shape belongs to its kind. */
  readonly answer: (answer: unknown) => void;
  /** Drop the open question without answering it. */
  readonly dismiss: () => void;
  /** A page of older messages is on its way. */
  readonly loadingOlder: boolean;
  /**
   * Ask for the page before the oldest message shown. Does nothing when there
   * is none, or when one is already on its way.
   */
  readonly loadOlder: () => void;
}

const LATEST = { kind: "latest" } as const;

function defaultNewId(): string {
  return crypto.randomUUID();
}

/**
 * Whether this outcome leaves the fate of the attempt unknown.
 *
 * The token exists to make a retry of an unknown attempt the *same* attempt.
 * So it survives every outcome where the earlier request may still have
 * created the order, and is dropped the moment the server tells us where the
 * conversation actually is.
 *
 * The first group: no response at all (`unreachable`, `unreadable`), nothing
 * attempted this time so the last attempt's fate stands (`not_sent`,
 * `turn_open`, `rate_limited`), or a fault that may have landed either side of
 * the write (`server`). The second group: the server read the conversation and
 * said where it is, and whatever the earlier attempt did is in the window
 * that came with the answer.
 *
 * A `switch` rather than a set, so a new kind of failure cannot be added
 * without someone deciding which of the two it is. Getting `turn_open` wrong
 * here would be silent: the retry would mint a new token, miss the receipt,
 * and write the order twice.
 */
function stillUnknown(kind: AssistantKitFailureKind): boolean {
  switch (kind) {
    case "unreachable":
    case "unreadable":
    case "not_sent":
    case "turn_open":
    case "rate_limited":
    case "server":
      return true;
    case "interaction_open":
    case "stale":
    case "unresolvable":
    case "action_failed":
    case "expired":
    case "rejected":
    case "unauthorized":
      return false;
  }
}

/**
 * Whether the words are safe to put back in the composer.
 *
 * Deliberately **not** the same question as `stillUnknown`, though the two
 * overlap. That one asks whether the attempt's fate is undecided, and keeps the
 * token accordingly; this one asks whether showing the words in an empty
 * composer would be telling the truth.
 *
 * They differ on exactly one case, and it is the case worth naming: `not_sent`
 * leaves the fate of whatever came *before* unknown, so the token is kept — but
 * this send itself never left the phone, so its words plainly belong back in the
 * field. Collapsing the two predicates loses that, and either strands the draft
 * or offers it back after a fault that may already have queued a turn.
 */
function draftReturns(kind: AssistantKitFailureKind): boolean {
  switch (kind) {
    // Either nothing left the phone at all (`not_sent`), or the server decided
    // this attempt and accepted no turn. In both the words are unambiguously
    // still the person's to send.
    case "not_sent":
    case "interaction_open":
    case "turn_open":
    case "stale":
    case "unresolvable":
    case "action_failed":
    case "expired":
    case "rejected":
    case "unauthorized":
    case "rate_limited":
      return true;
    // Undecided. The accept may have stored the message and queued the turn,
    // and a retry of the same words is the same attempt anyway — so the words
    // stay where the person can see them rather than going back into an empty
    // composer that invites a second send.
    case "unreachable":
    case "unreadable":
    case "server":
      return false;
  }
}

export function useAssistantConversation(args: {
  readonly conversationId: string | null;
  readonly locale: Locale;
  /** `null` until the session and the tenant are known. */
  readonly call: AssistantKitCall | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
  /**
   * The surface is on screen. Defaults to false: a caller that never says so
   * gets the thread and no connection, and a turn that starts anyway opens one
   * on its own (below). Nothing is streamed for a screen nobody is looking at.
   */
  readonly visible?: boolean;
  readonly newId?: () => string;
}): UseAssistantConversation {
  const [state, setState] = useState<AssistantThreadState>(
    initialAssistantThreadState,
  );
  const [sending, setSending] = useState(false);
  /**
   * Echoed in the thread until the reply lands. The server stores the person's
   * words before the model runs, so this is only ever showing what is already
   * committed — but the response that would prove it is a round trip away.
   */
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<AssistantKitFailure | null>(null);

  const callRef = useRef(args.call);
  callRef.current = args.call;
  const conversationIdRef = useRef(args.conversationId);
  conversationIdRef.current = args.conversationId;
  /**
   * The thread as it stands, readable synchronously.
   *
   * Deliberately **not** mirrored from `state` during render. Events arrive in
   * bursts — the stream writes its snapshot and everything queued behind it
   * back to back — and each has to be applied to the result of the one before
   * it. A ref that caught up only at the next render would hand the second
   * event the state from before the first, which lost the turn the client was
   * following and made its `turn.finished` read as somebody else's.
   *
   * So every change goes through `commit`, and this is the only copy that is
   * always current.
   */
  const stateRef = useRef(state);
  const newIdRef = useRef(args.newId ?? defaultNewId);
  newIdRef.current = args.newId ?? defaultNewId;
  const epochRef = args.tenantEpochRef;

  /** The one way the thread changes: the ref first, so the next caller sees it. */
  const commit = useCallback((next: AssistantThreadState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * Guards a second tap, not the protocol. Exactly-once is decided by the
   * server's claim, which is why there is no attempted-option bookkeeping here.
   *
   * The ticket is what makes "in flight" single-valued across a tenant switch:
   * bumping it orphans whatever is still running, so a reply that lands late
   * neither paints nor unlatches the surface it no longer owns.
   */
  const sendingRef = useRef(false);
  const ticketRef = useRef(0);

  /**
   * The token of an attempt whose fate the client does not know.
   *
   * A request that never came back may or may not have created the order.
   * Keeping the token makes a retry the *same* attempt, which the server
   * recognises and answers with the conversation as it now stands (SHO-547).
   *
   * Held while the outcome is still unknown, and dropped once the server has
   * decided this command. That is also what keeps sending the same sentence
   * twice on purpose from being collapsed into one.
   */
  const heldCommandRef = useRef<{
    readonly key: string;
    readonly commandId: string;
  } | null>(null);

  const commandIdFor = useCallback((key: string): string => {
    const held = heldCommandRef.current;
    if (held !== null && held.key === key) {
      return held.commandId;
    }
    const commandId = newIdRef.current();
    heldCommandRef.current = { key, commandId };
    return commandId;
  }, []);

  const settleCommand = useCallback(
    (key: string, failure: AssistantKitFailure | null): void => {
      if (failure !== null && stillUnknown(failure.kind)) {
        return;
      }
      if (heldCommandRef.current?.key === key) {
        heldCommandRef.current = null;
      }
    },
    [],
  );

  /**
   * Which send the echo on screen belongs to.
   *
   * A send clears its own echo when it settles, and only its own. After a switch
   * mid-flight a later send may have put its words there, and the earlier
   * send's late reply used to wipe them for the rest of that turn (SHO-552).
   */
  const echoRef = useRef<object | null>(null);

  /**
   * One way to apply an outcome, whatever produced it.
   *
   * Whatever the server sent about the conversation is joined onto the thread —
   * including on a refusal, where it is the corrected view of what the person is
   * looking at.
   *
   * A reply is dropped if the tenant or the conversation changed while it was in
   * flight. Both, not just the epoch: switching conversations without switching
   * company would otherwise let one thread's reply land in another.
   */
  const run = useCallback(
    (
      perform: (
        call: AssistantKitCall,
        conversationId: string,
      ) => Promise<AssistantKitOutcome>,
    ): Promise<RunResult> => {
      const call = callRef.current;
      const conversationId = conversationIdRef.current;
      if (call === null || conversationId === null || sendingRef.current) {
        // Nothing was attempted and nothing changed. `not_sent` is the reason a
        // caller can act on.
        return Promise.resolve<RunResult>({
          failure: { kind: "not_sent" },
          current: true,
        });
      }
      const epoch = epochRef.current;
      ticketRef.current += 1;
      const ticket = ticketRef.current;
      const mine = () => ticketRef.current === ticket;
      const current = () =>
        mine() &&
        epochRef.current === epoch &&
        conversationIdRef.current === conversationId;

      sendingRef.current = true;
      setSending(true);
      return perform(call, conversationId)
        .then((outcome): RunResult => {
          if (!current()) {
            return { failure: outcome.failure, current: false };
          }
          const incoming = outcome.window;
          if (incoming !== null) {
            commit(applyAssistantWindow(stateRef.current, incoming, LATEST));
          }
          setFailure(outcome.failure);
          return { failure: outcome.failure, current: true };
        })
        .catch((): RunResult => {
          const still = current();
          if (still) {
            setFailure({ kind: "unreachable" });
          }
          return { failure: { kind: "unreachable" }, current: still };
        })
        .finally(() => {
          // Unlatch only if this is still the request in flight. Whether its
          // result was applied is a separate question, already answered above.
          if (mine()) {
            sendingRef.current = false;
            setSending(false);
          }
        });
    },
    [commit, epochRef],
  );

  const reload = useCallback(() => {
    void run((call, conversationId) =>
      getAssistantKitWindow({ ...call, conversationId }),
    );
  }, [run]);

  /**
   * Reading the window because an event said this client cannot vouch for what
   * it holds — a `turn.finished` with no window, one for a turn this client was
   * not following, or a `message.updated` for a message it does not hold.
   *
   * Not `run`: this takes no command latch, so a re-read neither blocks a send
   * nor is blocked by one.
   *
   * **One at a time, but never dropped.** An ask that arrives while a read is
   * on its way sets a flag and gets exactly one more read when that one
   * settles. Dropping it instead would be wrong, not merely wasteful: the read
   * in flight may have been *issued before* the event that asked for this one,
   * so it can return state older than the regression it was meant to repair,
   * and a finished turn publishes nothing further to try again. `revision` does
   * not cover that gap — it orders `message.updated`, while an untracked
   * `turn.finished` hands a whole window to a latest-merge, which replaces the
   * thread from its first message on rather than comparing message by message.
   * The re-arm is what makes "corrected on the next round trip" true.
   *
   * This is not polling. It has no interval: every read is caused by an event
   * that arrived, and when nothing arrives nothing is asked.
   */
  const rereadRef = useRef<object | null>(null);
  const rereadAgainRef = useRef(false);
  const reread = useCallback(() => {
    if (rereadRef.current !== null) {
      rereadAgainRef.current = true;
      return;
    }
    const start = (): void => {
      // Read fresh each time: the second read belongs to whatever is on screen
      // when it is issued, not to what was when the first was.
      const call = callRef.current;
      const conversationId = conversationIdRef.current;
      if (call === null || conversationId === null) {
        return;
      }
      const epoch = epochRef.current;
      const request = {};
      /**
       * Ownership of the echo is captured **here**, when the read is issued,
       * not asked again when it answers. Those are different questions.
       *
       * The window this read returns describes the conversation as of the
       * moment it was taken, so a send in flight *then* may have accepted after
       * it — and by the time it resolves `sendingRef` has gone false, because
       * the send failed. Asking late therefore clears the echo of a send whose
       * words this window does not contain; an undecided send does not restore
       * the draft either, so they end up in neither place. That is the SHO-552
       * class again, reached through timing instead of through the
       * unconditional clear this replaced.
       */
      const sendingAtIssue = sendingRef.current;
      const echoAtIssue = echoRef.current;
      rereadRef.current = request;
      void getAssistantKitWindow({ ...call, conversationId })
        .then((outcome) => {
          if (
            rereadRef.current !== request ||
            epochRef.current !== epoch ||
            conversationIdRef.current !== conversationId
          ) {
            return;
          }
          const window = outcome.window;
          if (window === null) {
            return;
          }
          commit(applyAssistantWindow(stateRef.current, window, LATEST));
          if (
            !sendingAtIssue &&
            !sendingRef.current &&
            echoRef.current === echoAtIssue
          ) {
            // All three, and each rules out a different owner. No send was in
            // flight when this read was taken, so its window cannot predate
            // one; none is in flight now, so none is about to be answered by
            // its own settle; and the echo is still the one that was there at
            // issue, so this is not some later send's words. Only then is the
            // window just applied the newest account of the conversation, and
            // the echo answered by it.
            //
            // Otherwise the words belong to a send, and only that send may
            // take them off the screen.
            echoRef.current = null;
            setPending(null);
          }
          // Silent on failure: this read is the client's own housekeeping, not
          // something the person asked for, and the banner belongs to what they
          // did ask for.
        })
        .finally(() => {
          if (rereadRef.current !== request) {
            return;
          }
          rereadRef.current = null;
          if (rereadAgainRef.current) {
            rereadAgainRef.current = false;
            start();
          }
        });
    };
    start();
  }, [commit, epochRef]);

  const onStreamEvent = useCallback(
    (event: Parameters<typeof applyAssistantStreamEvent>[1]) => {
      const conversationId = conversationIdRef.current;
      if (conversationId === null) {
        return;
      }
      // The id this client asked for, so the merge can refuse an event for
      // another conversation even before the first window has landed.
      const applied = applyAssistantStreamEvent(
        stateRef.current,
        event,
        conversationId,
      );
      commit(applied.state);
      if (applied.rereadWindow) {
        reread();
      }
    },
    [commit, reread],
  );

  const turnActive = assistantTurnActive(state.thread);

  useAssistantStream({
    call: args.call,
    conversationId: args.conversationId,
    // A turn that is running has to be able to land wherever the person is, so
    // the stream outlives the sheet being closed for exactly as long as one is.
    listening: (args.visible ?? false) || turnActive,
    onEvent: onStreamEvent,
  });

  const send = useCallback(
    (text: string): Promise<AssistantSendOutcome> => {
      const clipped = clipAssistantKitText(text);
      if (clipped.length === 0) {
        return Promise.resolve<AssistantSendOutcome>({
          kind: "refused",
          failure: { kind: "not_sent" },
        });
      }
      // Keyed by the words, so retrying the same draft is the same attempt and
      // editing it before retrying is a new one.
      const key = `send:${clipped}`;
      const commandId = commandIdFor(key);
      const echo = {};
      echoRef.current = echo;
      setPending(clipped);
      return run((call, conversationId) =>
        postAssistantKitChat({
          ...call,
          conversationId,
          commandId,
          text: clipped,
        }),
      ).then(({ failure, current }): AssistantSendOutcome => {
        // Settled whether or not anyone is still looking: the token is about
        // the attempt, which the server has decided, not about the screen.
        settleCommand(key, failure);
        const undecided = failure !== null && !draftReturns(failure.kind);
        if (echoRef.current === echo && !undecided) {
          // Right after the thread that now contains it, so the echo is
          // replaced rather than briefly doubled. An undecided outcome keeps it:
          // the message may be stored and the turn running, and the next window
          // — from the stream, or from the re-read an event triggers — is what
          // replaces it with the stored message.
          echoRef.current = null;
          setPending(null);
        }
        if (!current) {
          // A thread nobody is looking at: nothing to restore, nothing to say.
          return { kind: "superseded" };
        }
        if (failure === null) {
          return { kind: "sent" };
        }
        return draftReturns(failure.kind)
          ? { kind: "refused", failure }
          : { kind: "unknown", failure };
      });
    },
    [commandIdFor, run, settleCommand],
  );

  /**
   * The open question is read at the moment of the tap, not from a copy captured
   * when the card rendered: `revision` is what the server checks, and answering
   * an older one must be refused rather than applied to a changed draft.
   */
  const answer = useCallback(
    (value: unknown) => {
      const open = stateRef.current.thread?.openPause ?? null;
      if (open === null) {
        return;
      }
      // The chosen option is part of the key: tapping the same one again after
      // a lost reply is a retry, tapping a different one is a different answer.
      const key = `answer:${open.interactionId}:${String(open.revision)}:${JSON.stringify(value)}`;
      const commandId = commandIdFor(key);
      void run((call, conversationId) =>
        postAssistantKitAnswer({
          ...call,
          conversationId,
          commandId,
          interactionId: open.interactionId,
          revision: open.revision,
          answer: value,
        }),
      ).then(({ failure }) => {
        settleCommand(key, failure);
      });
    },
    [commandIdFor, run, settleCommand],
  );

  const dismiss = useCallback(() => {
    const open = stateRef.current.thread?.openPause ?? null;
    if (open === null) {
      return;
    }
    void run((call, conversationId) =>
      postAssistantKitAbandon({
        ...call,
        conversationId,
        interactionId: open.interactionId,
      }),
    );
  }, [run]);

  /**
   * The older page on its way, if any. Its own latch, not `sending`: reading
   * history changes nothing on the server, so a person scrolling back does not
   * wait for a reply to finish, and a send does not wait for a page.
   */
  const olderRef = useRef<object | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  /**
   * Whether the page joins the thread is `mergeAssistantChatWindow`'s question:
   * only if the thread still starts where the page was asked from. A reply that
   * arrived in between may have reset it, and a page for a thread that is gone
   * must not be put in front of the one that replaced it.
   */
  const loadOlder = useCallback(() => {
    const call = callRef.current;
    const conversationId = conversationIdRef.current;
    const cursor = stateRef.current.thread?.olderCursor ?? null;
    if (
      call === null ||
      conversationId === null ||
      cursor === null ||
      olderRef.current !== null
    ) {
      return;
    }
    const epoch = epochRef.current;
    const request = {};
    olderRef.current = request;
    setLoadingOlder(true);
    void getAssistantKitWindow({ ...call, conversationId, before: cursor })
      .then((outcome) => {
        if (
          olderRef.current !== request ||
          epochRef.current !== epoch ||
          conversationIdRef.current !== conversationId
        ) {
          return;
        }
        const page = outcome.window;
        if (page !== null) {
          commit(
            applyAssistantWindow(stateRef.current, page, {
              kind: "older",
              cursor,
            }),
          );
        }
        // Said, not swallowed. Success leaves the banner alone: it may be
        // reporting a refused send that this page has nothing to do with.
        if (outcome.failure !== null) {
          setFailure(outcome.failure);
        }
      })
      .finally(() => {
        if (olderRef.current === request) {
          olderRef.current = null;
          setLoadingOlder(false);
        }
      });
  }, [commit, epochRef]);

  // A new tenant or a new conversation is a different thread. Clearing before
  // the read is deliberate: showing the previous company's thread for the length
  // of one request is worse than showing nothing.
  useEffect(() => {
    commit(initialAssistantThreadState());
    setFailure(null);
    setPending(null);
    echoRef.current = null;
    // Orphan anything still running for the previous conversation, then read.
    ticketRef.current += 1;
    sendingRef.current = false;
    olderRef.current = null;
    rereadRef.current = null;
    rereadAgainRef.current = false;
    setLoadingOlder(false);
    reload();
  }, [args.conversationId, args.call, commit, reload]);

  const rows = useMemo(
    () =>
      state.thread === null
        ? []
        : assistantThreadRows({
            thread: state.thread,
            locale: args.locale,
            // The placeholder the accept stores renders as nothing of its own,
            // so the waiting row is what says a turn is under way. It also
            // covers the accept's round trip, before any placeholder exists.
            waiting: turnActive || sending,
            pending,
          }),
    [state.thread, args.locale, turnActive, sending, pending],
  );

  const interaction = useMemo(() => {
    const open = state.thread?.openPause ?? null;
    return open === null ? null : assistantInteractionFromPause(open);
  }, [state.thread]);

  return {
    rows,
    interaction,
    busy: turnActive,
    sending,
    failure,
    send,
    answer,
    dismiss,
    loadingOlder,
    loadOlder,
  };
}
