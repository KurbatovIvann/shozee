import { useCallback, useMemo, useRef, useState } from "react";

import type { AssistantCompanyEpochRef } from "../shared/assistant-session";
import {
  confirmationCardState,
  commitConfirmationConfirmResult,
  executeConfirmationConfirm,
  executeConfirmationDismiss,
  pendingConfirmationFromMessages,
  type AssistantChatMessage,
  type ConfirmationAppendPart,
  type ConfirmationCardState,
  type ConfirmationConfirmResult,
  type PendingConfirmation,
} from "../shared/confirmation-presenter";

export type AssistantChatStatus = "submitted" | "streaming" | "ready" | "error";

export function useAssistantConfirmation(args: {
  readonly messages: readonly AssistantChatMessage[];
  readonly locale: "uk" | "en";
  readonly sendBusy: boolean;
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly postConfirm: (input: {
    readonly challengeId: string;
  }) => Promise<ConfirmationConfirmResult>;
  readonly appendParts: (parts: readonly ConfirmationAppendPart[]) => void;
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
  const [ignored, setIgnored] = useState<ReadonlySet<string>>(() => new Set());
  const [resolvingChallengeId, setResolvingChallengeId] = useState<
    string | null
  >(null);
  const dismissedRef = useRef<ReadonlySet<string>>(new Set());
  const ignoredRef = useRef<ReadonlySet<string>>(new Set());
  const resolvingRef = useRef<string | null>(null);

  const clearResolving = useCallback(() => {
    resolvingRef.current = null;
    setResolvingChallengeId(null);
  }, []);

  const hiddenIds = useMemo(() => {
    const next = new Set(dismissed);
    for (const challengeId of ignored) {
      next.add(challengeId);
    }
    return next;
  }, [dismissed, ignored]);

  const pending = pendingConfirmationFromMessages(args.messages, hiddenIds);
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
    void executeConfirmationConfirm({
      pending: current,
      sendBusy: args.sendBusy,
      dismissedChallengeIds: dismissedRef.current,
      resolvingRef,
      postConfirm: args.postConfirm,
    })
      .then((result) => {
        const outcome = commitConfirmationConfirmResult({
          result,
          previousChallengeId: current.challengeId,
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
        clearResolving();
      })
      .catch(() => {
        if (resolvingRef.current === current.challengeId) {
          clearResolving();
        }
      });
  }, [
    args.appendParts,
    args.companyEpochRef,
    args.locale,
    args.postConfirm,
    args.sendBusy,
    clearResolving,
  ]);

  const dismiss = useCallback(() => {
    const next = executeConfirmationDismiss({
      pending: pendingRef.current,
      dismissed: dismissedRef.current,
    });
    dismissedRef.current = next;
    setDismissed(next);
  }, []);

  const reset = useCallback(() => {
    const empty = new Set<string>();
    dismissedRef.current = empty;
    ignoredRef.current = empty;
    pendingRef.current = null;
    resolvingRef.current = null;
    setDismissed(empty);
    setIgnored(empty);
    setResolvingChallengeId(null);
  }, []);

  return {
    pending,
    ignoredChallengeIds: hiddenIds,
    card,
    confirm,
    dismiss,
    reset,
  };
}
