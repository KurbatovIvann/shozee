import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  executeConfirmationAbandon,
  executeConfirmationConfirm,
  hideConfirmationLocally,
  pendingConfirmationFromMessages,
  confirmationCardState,
  shouldMarkConfirmationResolved,
  type AssistantChatMessage,
  type ConfirmationCardState,
  type PendingConfirmation,
} from "../shared/confirmation-presenter";
import {
  partsFromResumeEnvelope,
  pendingHostMetaFromPublic,
  type AssistantHostInteractionResult,
  type AssistantPendingHostMeta,
  type ResumeAppendPart,
} from "../shared/resume-envelope";

export type AssistantChatStatus = "submitted" | "streaming" | "ready" | "error";

export function useAssistantConfirmation(args: {
  readonly messages: readonly AssistantChatMessage[];
  readonly status: AssistantChatStatus;
  readonly error: unknown;
  readonly sendBusy: boolean;
  readonly conversationId: string | null;
  readonly pendingMetaRef: { current: AssistantPendingHostMeta | null };
  readonly postConfirm: (input: {
    readonly conversationId: string;
    readonly challengeId: string;
  }) => Promise<AssistantHostInteractionResult>;
  readonly peekPending: () => Promise<
    | {
        readonly kind: "ok";
        readonly pending: AssistantPendingHostMeta | null;
      }
    | { readonly kind: "unavailable" }
  >;
  readonly postAbandon: (input: {
    readonly conversationId: string;
    readonly pendingId: string;
    readonly expectedVersion: number;
  }) => Promise<AssistantHostInteractionResult>;
  readonly appendParts: (parts: readonly ResumeAppendPart[]) => void;
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
      conversationId: args.conversationId,
      postConfirm: args.postConfirm,
    })
      .then((result) => {
        if (result === "skipped") {
          clearResolving();
          return;
        }
        if (result.status === "ok") {
          args.pendingMetaRef.current = pendingHostMetaFromPublic(
            result.pending,
          );
          const parts = partsFromResumeEnvelope({
            speech: result.speech,
            cards: result.cards,
            pending: result.pending,
          });
          if (parts.length > 0) {
            args.appendParts(parts);
          }
          setResolved((currentResolved) => {
            const next = new Set(currentResolved);
            next.add(current.challengeId);
            return next;
          });
        }
        clearResolving();
      })
      .catch(() => {
        clearResolving();
      });
  }, [
    args.appendParts,
    args.conversationId,
    args.pendingMetaRef,
    args.postConfirm,
    args.sendBusy,
    clearResolving,
  ]);

  const dismiss = useCallback(() => {
    const current = pendingRef.current;
    void executeConfirmationAbandon({
      pending: current,
      conversationId: args.conversationId,
      pendingVersion: args.pendingMetaRef.current?.version,
      peekPending: args.peekPending,
      postAbandon: args.postAbandon,
    }).then((result) => {
      if (result === "skipped") {
        return;
      }
      if (result.status === "ok" || result.status === "expired") {
        args.pendingMetaRef.current = null;
        const next = hideConfirmationLocally({
          pending: current,
          dismissed: dismissedRef.current,
        });
        dismissedRef.current = next;
        setDismissed(next);
      }
    });
  }, [
    args.conversationId,
    args.peekPending,
    args.pendingMetaRef,
    args.postAbandon,
  ]);

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
