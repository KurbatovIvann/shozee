/**
 * The whole assistant surface, as three pieces of state: the document, whether
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
 * The rule that makes it small: every call answers with the whole conversation,
 * so every outcome is applied the same way. A success and a refusal both carry
 * the document; the refusal additionally has something to say. There is no
 * splicing, no locally invented part, and no second derivation to keep in step
 * with the first.
 *
 * `busy` is one flag for the whole surface, not one per card. While anything is
 * in flight nothing else may be sent — which is what the server enforces anyway,
 * since one open question blocks the next job.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assistantInteractionFromPause,
  type AssistantChatDocument,
  type AssistantInteraction,
} from "@showzy/validation/assistant-chat";

import type { Locale } from "../../../i18n/locale";
import {
  clipAssistantKitText,
  getAssistantKitDocument,
  postAssistantKitAbandon,
  postAssistantKitAnswer,
  postAssistantKitChat,
  type AssistantKitCall,
  type AssistantKitFailure,
  type AssistantKitOutcome,
} from "../api/assistant-kit-client";
import {
  assistantDocumentRows,
  type AssistantDocumentRow,
} from "./document-rows";

/**
 * Bumped by the caller when the tenant or the signed-in person changes. A reply
 * that arrives after that belongs to a conversation nobody is looking at, and
 * applying it would show one company's data under another.
 */
export type AssistantTenantEpochRef = { current: number };

export interface UseAssistantConversation {
  readonly rows: readonly AssistantDocumentRow[];
  /** The open question, if any, with its prompt already parsed. */
  readonly interaction: AssistantInteraction | null;
  readonly busy: boolean;
  readonly failure: AssistantKitFailure | null;
  /**
   * Resolves to `null` when the turn ran, and to the reason when it did not — so
   * a caller holding the draft knows whether to put the text back in the field.
   */
  readonly send: (text: string) => Promise<AssistantKitFailure | null>;
  /** Answer the open question. The shape belongs to its kind. */
  readonly answer: (answer: unknown) => void;
  /** Drop the open question without answering it. */
  readonly dismiss: () => void;
  readonly reload: () => void;
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

export function useAssistantConversation(args: {
  readonly conversationId: string | null;
  readonly locale: Locale;
  /** `null` until the session and the tenant are known. */
  readonly call: AssistantKitCall | null;
  readonly tenantEpochRef: AssistantTenantEpochRef;
  readonly newId?: () => string;
}): UseAssistantConversation {
  const [document, setDocument] = useState<AssistantChatDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AssistantKitFailure | null>(null);

  const callRef = useRef(args.call);
  callRef.current = args.call;
  const conversationIdRef = useRef(args.conversationId);
  conversationIdRef.current = args.conversationId;
  const documentRef = useRef(document);
  documentRef.current = document;
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
   * One way to apply an outcome, whatever produced it.
   *
   * The document is taken whenever the server sent one — including on a refusal,
   * where it is the corrected view of what the person is looking at.
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
    ): Promise<AssistantKitFailure | null> => {
      const call = callRef.current;
      const conversationId = conversationIdRef.current;
      if (call === null || conversationId === null || busyRef.current) {
        // Nothing was attempted. `aborted` is the reason a caller can act on.
        return Promise.resolve({ kind: "aborted" });
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
        .then((outcome): AssistantKitFailure | null => {
          if (!current()) {
            return outcome.failure;
          }
          if (outcome.document !== null) {
            setDocument(outcome.document);
          }
          setFailure(outcome.failure);
          return outcome.failure;
        })
        .catch((): AssistantKitFailure => {
          if (current()) {
            setFailure({ kind: "unreachable" });
          }
          return { kind: "unreachable" };
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
      getAssistantKitDocument({ ...call, conversationId }),
    );
  }, [run]);

  const send = useCallback(
    (text: string) => {
      const clipped = clipAssistantKitText(text);
      if (clipped.length === 0) {
        return Promise.resolve<AssistantKitFailure>({ kind: "aborted" });
      }
      const commandId = newIdRef.current();
      return run((call, conversationId) =>
        postAssistantKitChat({
          ...call,
          conversationId,
          commandId,
          text: clipped,
        }),
      );
    },
    [run],
  );

  /**
   * The open question is read at the moment of the tap, not from a copy captured
   * when the card rendered: `revision` is what the server checks, and answering
   * an older one must be refused rather than applied to a changed draft.
   */
  const answer = useCallback(
    (value: unknown) => {
      const open = documentRef.current?.openPause ?? null;
      if (open === null) {
        return;
      }
      const commandId = newIdRef.current();
      void run((call, conversationId) =>
        postAssistantKitAnswer({
          ...call,
          conversationId,
          commandId,
          interactionId: open.interactionId,
          revision: open.revision,
          answer: value,
        }),
      );
    },
    [run],
  );

  const dismiss = useCallback(() => {
    const open = documentRef.current?.openPause ?? null;
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

  // A new tenant or a new conversation is a different document. Clearing before
  // the read is deliberate: showing the previous company's thread for the length
  // of one request is worse than showing nothing.
  useEffect(() => {
    setDocument(null);
    documentRef.current = null;
    setFailure(null);
    // Orphan anything still running for the previous conversation, then read.
    ticketRef.current += 1;
    busyRef.current = false;
    reload();
  }, [args.conversationId, args.call, reload]);

  const rows = useMemo(
    () =>
      document === null
        ? []
        : assistantDocumentRows({
            document,
            locale: args.locale,
            waiting: busy,
          }),
    [document, args.locale, busy],
  );

  const interaction = useMemo(
    () =>
      document?.openPause === null || document?.openPause === undefined
        ? null
        : assistantInteractionFromPause(document.openPause),
    [document],
  );

  return { rows, interaction, busy, failure, send, answer, dismiss, reload };
}
