import { useCallback, useMemo, useRef, useState } from "react";

import type { AssistantCompanyEpochRef } from "../shared/assistant-session";
import {
  commitHostConfirmResult,
  confirmationCardState,
  executeConfirmationAbandon,
  executeHostConfirmationConfirm,
  hideConfirmationLocally,
  pendingConfirmationFromMessages,
  shouldHidePendingCardAfterAbandon,
  type AssistantChatMessage,
  type ConfirmationCardState,
  type PendingConfirmation,
} from "../shared/confirmation-presenter";
import type { AssistantHostInteractionResult } from "../shared/resume-envelope";
import type { ChoiceAppendPart } from "../shared/choice-presenter";

export type AssistantChatStatus = "submitted" | "streaming" | "ready" | "error";

export function useAssistantConfirmation(args: {
  readonly messages: readonly AssistantChatMessage[];
  readonly sendBusy: boolean;
  readonly companyEpochRef: AssistantCompanyEpochRef;
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
  readonly postConfirm: (input: {
    readonly conversationId: string;
    readonly challengeId: string;
  }) => Promise<AssistantHostInteractionResult>;
  readonly postAbandon: (input: {
    readonly conversationId: string;
    readonly pendingId: string;
    readonly expectedVersion: number;
  }) => Promise<AssistantHostInteractionResult>;
  readonly appendParts: (parts: readonly ChoiceAppendPart[]) => void;
}): {
  readonly pending: PendingConfirmation | null;
  readonly ignoredChallengeIds: ReadonlySet<string>;
  readonly card: ConfirmationCardState;
  readonly confirm: () => void;
  readonly dismiss: () => void;
  readonly reset: () => void;
} {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resolved, setResolved] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [resolvingChallengeId, setResolvingChallengeId] = useState<
    string | null
  >(null);
  const dismissedRef = useRef<ReadonlySet<string>>(new Set());
  const resolvingRef = useRef<string | null>(null);

  const clearResolving = useCallback(() => {
    resolvingRef.current = null;
    setResolvingChallengeId(null);
  }, []);

  const ignoreChallenge = useCallback((challengeId: string) => {
    const next = new Set(dismissedRef.current);
    next.add(challengeId);
    dismissedRef.current = next;
    setDismissed(next);
    setResolved((current) => {
      const resolvedNext = new Set(current);
      resolvedNext.add(challengeId);
      return resolvedNext;
    });
  }, []);

  const ignored = useMemo(() => {
    const next = new Set(dismissed);
    for (const challengeId of resolved) {
      next.add(challengeId);
    }
    return next;
  }, [dismissed, resolved]);

  const pending = pendingConfirmationFromMessages(args.messages, ignored);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const card = confirmationCardState({
    pending,
    resolvingChallengeId,
  });

  const confirm = useCallback(() => {
    const current = pendingRef.current;
    if (current === null || resolvingRef.current !== null) {
      return;
    }
    const epoch = args.companyEpochRef.current;
    setResolvingChallengeId(current.challengeId);
    void executeHostConfirmationConfirm({
      pending: current,
      sendBusy: args.sendBusy,
      dismissedChallengeIds: dismissedRef.current,
      resolvingRef,
      conversationId: args.getConversationId(),
      postConfirm: args.postConfirm,
    })
      .then((result) => {
        const outcome = commitHostConfirmResult({
          result,
          previousChallengeId: current.challengeId,
          companyEpochRef: args.companyEpochRef,
          epoch,
          resolvingRef,
          appendParts: args.appendParts,
          ignoreChallenge,
        });
        if (outcome === "stale") {
          return;
        }
        clearResolving();
      })
      .catch(() => {
        if (
          args.companyEpochRef.current === epoch &&
          resolvingRef.current === current.challengeId
        ) {
          clearResolving();
        }
      });
  }, [
    args.appendParts,
    args.companyEpochRef,
    args.getConversationId,
    args.postConfirm,
    args.sendBusy,
    clearResolving,
    ignoreChallenge,
  ]);

  const dismiss = useCallback(() => {
    const current = pendingRef.current;
    void executeConfirmationAbandon({
      pending: current,
      conversationId: args.getConversationId(),
      pendingVersion: current?.pendingVersion,
      peekPending: args.peekPending,
      postAbandon: args.postAbandon,
    }).then((result) => {
      if (!shouldHidePendingCardAfterAbandon(result)) {
        return;
      }
      const next = hideConfirmationLocally({
        pending: pendingRef.current,
        dismissed: dismissedRef.current,
      });
      dismissedRef.current = next;
      setDismissed(next);
    });
  }, [args.getConversationId, args.peekPending, args.postAbandon]);

  const reset = useCallback(() => {
    const empty = new Set<string>();
    dismissedRef.current = empty;
    pendingRef.current = null;
    resolvingRef.current = null;
    setDismissed(empty);
    setResolved(new Set());
    setResolvingChallengeId(null);
  }, []);

  return {
    pending,
    ignoredChallengeIds: ignored,
    card,
    confirm,
    dismiss,
    reset,
  };
}
