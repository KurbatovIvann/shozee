import { useCallback, useMemo, useRef, useState } from "react";

import type { AssistantCompanyEpochRef } from "../shared/assistant-session";
import {
  canSelectChoiceOption,
  choiceCardState,
  choiceSelectRememberedAttempt,
  commitChoiceSelectResult,
  executeChoiceAbandon,
  executeChoiceSelect,
  hideChoiceLocally,
  pendingChoiceFromMessages,
  type AssistantChoiceMessage,
  type ChoiceAppendPart,
  type ChoiceAttemptedOption,
  type ChoiceCardState,
  type ChoiceSelectResult,
  type PendingChoice,
} from "../shared/choice-presenter";
import {
  shouldHidePendingCardAfterAbandon,
  type AssistantHostInteractionResult,
} from "../shared/resume-envelope";

export function useAssistantChoice(args: {
  readonly messages: readonly AssistantChoiceMessage[];
  readonly locale: "uk" | "en";
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly postChoice: (input: {
    readonly choiceId: string;
    readonly optionId: string;
  }) => Promise<ChoiceSelectResult>;
  readonly appendParts: (parts: readonly ChoiceAppendPart[]) => void;
  readonly getConversationId: () => string | null;
  readonly peekPending: () => Promise<
    | {
        readonly kind: "ok";
        readonly pending: {
          readonly id: string;
          readonly version: number;
          readonly kind: "choice" | "confirmation";
        } | null;
      }
    | { readonly kind: "unavailable" }
  >;
  readonly postAbandon: (input: {
    readonly conversationId: string;
    readonly pendingId: string;
    readonly expectedVersion: number;
  }) => Promise<AssistantHostInteractionResult>;
}): {
  readonly pending: PendingChoice | null;
  readonly ignoredChallengeIds: ReadonlySet<string>;
  readonly card: ChoiceCardState;
  readonly attempted: ChoiceAttemptedOption | null;
  readonly select: (optionId: string) => void;
  readonly dismiss: () => void;
  readonly reset: () => void;
} {
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const [resolvingChallengeId, setResolvingChallengeId] = useState<
    string | null
  >(null);
  const [attempted, setAttempted] = useState<ChoiceAttemptedOption | null>(
    null,
  );
  const ignoredRef = useRef<ReadonlySet<string>>(new Set());
  const resolvingRef = useRef<string | null>(null);
  const attemptedRef = useRef<ChoiceAttemptedOption | null>(null);

  const clearResolving = useCallback(() => {
    resolvingRef.current = null;
    setResolvingChallengeId(null);
  }, []);

  const pending = pendingChoiceFromMessages(args.messages, ignored);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const card = choiceCardState({
    pending,
    resolvingChallengeId,
  });

  const select = useCallback(
    (optionId: string) => {
      const current = pendingRef.current;
      if (current === null || resolvingRef.current !== null) {
        return;
      }
      if (
        !canSelectChoiceOption({
          pending: current,
          optionId,
          attempted: attemptedRef.current,
        })
      ) {
        return;
      }
      const epoch = args.companyEpochRef.current;
      setResolvingChallengeId(current.challengeId);
      void executeChoiceSelect({
        pending: current,
        optionId,
        resolvingRef,
        attempted: attemptedRef.current,
        postChoice: args.postChoice,
      })
        .then((result) => {
          const outcome = commitChoiceSelectResult({
            result,
            previousChoiceId: current.challengeId,
            locale: args.locale,
            companyEpochRef: args.companyEpochRef,
            epoch,
            resolvingRef,
            appendParts: args.appendParts,
            ignoreChallenge: (challengeId) => {
              const next = new Set(ignoredRef.current);
              next.add(challengeId);
              ignoredRef.current = next;
              setIgnored(next);
            },
          });
          if (outcome === "stale") {
            return;
          }
          const remembered = choiceSelectRememberedAttempt({
            result,
            challengeId: current.challengeId,
            optionId,
            previous: attemptedRef.current,
          });
          attemptedRef.current = remembered;
          setAttempted(remembered);
          clearResolving();
        })
        .catch(() => {
          // Transport throw: leave the picker retryable, but keep the
          // attempted option so a different tap cannot POST while A may
          // already be claimed. Terminal `{ status: "error" }` bodies
          // are handled in `then`.
          if (resolvingRef.current === current.challengeId) {
            const next = {
              challengeId: current.challengeId,
              optionId,
            };
            attemptedRef.current = next;
            setAttempted(next);
            clearResolving();
          }
        });
    },
    [
      args.appendParts,
      args.companyEpochRef,
      args.locale,
      args.postChoice,
      clearResolving,
    ],
  );

  const dismiss = useCallback(() => {
    const current = pendingRef.current;
    void executeChoiceAbandon({
      pending: current,
      conversationId: args.getConversationId(),
      pendingVersion: current?.pendingVersion,
      peekPending: args.peekPending,
      postAbandon: args.postAbandon,
    }).then((result) => {
      if (!shouldHidePendingCardAfterAbandon(result)) {
        return;
      }
      const next = hideChoiceLocally({
        pending: pendingRef.current,
        dismissed: ignoredRef.current,
      });
      ignoredRef.current = next;
      setIgnored(next);
    });
  }, [args.getConversationId, args.peekPending, args.postAbandon]);

  const reset = useCallback(() => {
    const empty = new Set<string>();
    ignoredRef.current = empty;
    pendingRef.current = null;
    resolvingRef.current = null;
    attemptedRef.current = null;
    setIgnored(empty);
    setResolvingChallengeId(null);
    setAttempted(null);
  }, []);

  const ignoredChallengeIds = useMemo(() => ignored, [ignored]);

  return {
    pending,
    ignoredChallengeIds,
    card,
    attempted,
    select,
    dismiss,
    reset,
  };
}
