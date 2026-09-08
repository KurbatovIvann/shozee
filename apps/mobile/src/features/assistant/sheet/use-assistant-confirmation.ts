import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  confirmationCardState,
  executeConfirmationConfirm,
  executeConfirmationDismiss,
  pendingConfirmationFromMessages,
  shouldMarkConfirmationResolved,
  type AssistantChatMessage,
  type ConfirmationCardState,
  type PendingConfirmation,
} from "../shared/confirmation-presenter";

export type AssistantChatStatus = "submitted" | "streaming" | "ready" | "error";

export function useAssistantConfirmation(args: {
  readonly messages: readonly AssistantChatMessage[];
  readonly status: AssistantChatStatus;
  readonly error: unknown;
  readonly sendBusy: boolean;
  readonly resume: (headers: Readonly<Record<string, string>>) => Promise<void>;
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

  const previousStatus = useRef(args.status);
  useEffect(() => {
    if (args.status === "error") {
      clearResolving();
    }
  }, [args.status, clearResolving]);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = args.status;
    const wasBusy = previous === "submitted" || previous === "streaming";
    if (args.status !== "ready" || !wasBusy || resolvingChallengeId === null) {
      return;
    }
    if (
      shouldMarkConfirmationResolved({
        resolvingChallengeId,
        pending,
        hasError: args.error !== undefined && args.error !== null,
        messages: args.messages,
      })
    ) {
      const challengeId = resolvingChallengeId;
      setResolved((current) => {
        const next = new Set(current);
        next.add(challengeId);
        return next;
      });
    }
    clearResolving();
  }, [
    args.error,
    args.messages,
    args.status,
    clearResolving,
    pending,
    resolvingChallengeId,
  ]);

  const confirm = useCallback(() => {
    const current = pendingRef.current;
    if (current === null || resolvingRef.current !== null) {
      return;
    }
    setResolvingChallengeId(current.challengeId);
    void executeConfirmationConfirm({
      pending: current,
      sendBusy: args.sendBusy,
      dismissedChallengeIds: dismissedRef.current,
      resolvingRef,
      resume: args.resume,
    })
      .then((result) => {
        if (result === "skipped") {
          clearResolving();
        }
      })
      .catch(() => {
        clearResolving();
      });
  }, [args.resume, args.sendBusy, clearResolving]);

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
