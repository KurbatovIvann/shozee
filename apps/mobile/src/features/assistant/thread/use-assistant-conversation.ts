/**
 * The whole assistant surface, as three pieces of state: the thread, whether
 * a request is in flight, and what last went wrong.
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
 * something to say. Windows join into one thread through one function,
 * `mergeAssistantChatWindow`, by message id. A message never changes once its
 * request ends, so that join copies the server's log; there is no locally
 * invented part and no second derivation to keep in step with the first.
 *
 * `busy` is one flag for the whole surface, not one per card. While anything is
 * in flight nothing else may be sent — which is what the server enforces anyway,
 * since one open question blocks the next job.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assistantInteractionFromPause,
  mergeAssistantChatWindow,
  type AssistantChatThread,
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
 * `refused` is the only outcome that gives the words back. `superseded` means
 * the tenant or the conversation changed while it was in flight: whatever came
 * back belongs to a thread nobody is looking at, so there is nothing to restore
 * and nothing to report on this one (SHO-552).
 */
export type AssistantSendOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "refused"; readonly failure: AssistantKitFailure }
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
  readonly busy: boolean;
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
 * attempted this time so the last attempt's fate stands (`aborted`,
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
    case "aborted":
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

export function useAssistantConversation(args: {
  readonly conversationId: string | null;
  readonly locale: Locale;
  /** `null` until the session and the tenant are known. */
  readonly call: AssistantKitCall | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
  readonly newId?: () => string;
}): UseAssistantConversation {
  const [thread, setThread] = useState<AssistantChatThread | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Echoed in the thread until the reply lands. The server stores the person's
   * words before the model runs, so this is only ever showing what is already
   * committed — but the response that would prove it is a turn away.
   */
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<AssistantKitFailure | null>(null);

  const callRef = useRef(args.call);
  callRef.current = args.call;
  const conversationIdRef = useRef(args.conversationId);
  conversationIdRef.current = args.conversationId;
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const newIdRef = useRef(args.newId ?? defaultNewId);
  newIdRef.current = args.newId ?? defaultNewId;
  const epochRef = args.tenantEpochRef;

  /**
   * Guards a second tap, not the protocol. Exactly-once is decided by the
   * server's claim, which is why there is no attempted-option bookkeeping here.
   *
   * The ticket is what makes "in flight" single-valued across a tenant switch:
   * bumping it orphans whatever is still running, so a reply that lands late
   * neither paints nor unlatches the surface it no longer owns.
   */
  const busyRef = useRef(false);
  const ticketRef = useRef(0);

  /**
   * The token of an attempt whose fate the client does not know.
   *
   * A request that never came back may or may not have created the order. A
   * fresh token would write it twice — and the person is invited to try, since
   * the draft goes back into the field. Keeping the token makes the retry the
   * *same* attempt, which the server recognises and answers with the
   * conversation as it now stands (SHO-547).
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
   * One way to apply an outcome, whatever produced it.
   *
   * Whatever the server sent about the conversation is joined onto the thread —
   * including on a refusal, where it is the corrected view of what the person is
   * looking at.
   *
   * A reply is dropped if the tenant or the conversation changed while it was in
   * flight. Both, not just the epoch: switching conversations without switching
   * company would otherwise let one thread's reply land in another.
   *
   * Whether it was dropped goes back to the caller with the failure. Anything a
   * caller does after the window — put a draft back, clear an echo — depends
   * on the same question this has just answered. A caller that answered it again
   * for itself, from a failure alone, put one company's words into another
   * company's composer (SHO-552).
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
      if (call === null || conversationId === null || busyRef.current) {
        // Nothing was attempted and nothing changed. `aborted` is the reason a
        // caller can act on.
        return Promise.resolve<RunResult>({
          failure: { kind: "aborted" },
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

      busyRef.current = true;
      setBusy(true);
      return perform(call, conversationId)
        .then((outcome): RunResult => {
          if (!current()) {
            return { failure: outcome.failure, current: false };
          }
          const incoming = outcome.window;
          if (incoming !== null) {
            setThread((held) =>
              mergeAssistantChatWindow(held, incoming, LATEST),
            );
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
            busyRef.current = false;
            setBusy(false);
          }
        });
    },
    [epochRef],
  );

  const reload = useCallback(() => {
    void run((call, conversationId) =>
      getAssistantKitWindow({ ...call, conversationId }),
    );
  }, [run]);

  /**
   * Which send the echo on screen belongs to.
   *
   * A send clears its own echo when it settles, and only its own. After a switch
   * mid-flight a later send may have put its words there, and the earlier
   * send's late reply used to wipe them for the rest of that turn (SHO-552).
   * Ownership rather than currency: a reply nobody is looking at still takes
   * back the echo it left, if nothing replaced it.
   */
  const echoRef = useRef<object | null>(null);

  const send = useCallback(
    (text: string): Promise<AssistantSendOutcome> => {
      const clipped = clipAssistantKitText(text);
      if (clipped.length === 0) {
        return Promise.resolve<AssistantSendOutcome>({
          kind: "refused",
          failure: { kind: "aborted" },
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
        if (echoRef.current === echo) {
          // Right after the thread that now contains it, so the echo is
          // replaced rather than briefly doubled.
          echoRef.current = null;
          setPending(null);
        }
        if (!current) {
          // A thread nobody is looking at: nothing to restore, nothing to say.
          return { kind: "superseded" };
        }
        return failure === null
          ? { kind: "sent" }
          : { kind: "refused", failure };
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
      const open = threadRef.current?.openPause ?? null;
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
    const open = threadRef.current?.openPause ?? null;
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
   * The older page on its way, if any. Its own latch, not `busy`: reading
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
    const cursor = threadRef.current?.olderCursor ?? null;
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
          setThread((held) =>
            mergeAssistantChatWindow(held, page, { kind: "older", cursor }),
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
  }, [epochRef]);

  // A new tenant or a new conversation is a different thread. Clearing before
  // the read is deliberate: showing the previous company's thread for the length
  // of one request is worse than showing nothing.
  useEffect(() => {
    setThread(null);
    threadRef.current = null;
    setFailure(null);
    setPending(null);
    // Orphan anything still running for the previous conversation, then read.
    ticketRef.current += 1;
    busyRef.current = false;
    olderRef.current = null;
    setLoadingOlder(false);
    reload();
  }, [args.conversationId, args.call, reload]);

  const rows = useMemo(
    () =>
      thread === null
        ? []
        : assistantThreadRows({
            thread,
            locale: args.locale,
            waiting: busy,
            pending,
          }),
    [thread, args.locale, busy, pending],
  );

  const interaction = useMemo(
    () =>
      thread?.openPause === null || thread?.openPause === undefined
        ? null
        : assistantInteractionFromPause(thread.openPause),
    [thread],
  );

  return {
    rows,
    interaction,
    busy,
    failure,
    send,
    answer,
    dismiss,
    loadingOlder,
    loadOlder,
  };
}
