/**
 * HITL card presenter for the staff assistant (SHO-516). Confirm POSTs
 * `/assistant/confirm`. Dismiss is local — it must not execute.
 */
import { CONFIRMATION_CHALLENGE_HEADER } from "@showzy/contract";

import { assistantCopy } from "../../../i18n/assistant";
import type { AssistantCompanyEpochRef } from "./assistant-session";
import {
  confirmationFromChatPart,
  type StaffAssistantConfirmation,
} from "./confirmation";

export type AssistantChatPart = {
  readonly type: string;
  readonly text?: string;
  readonly data?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly output?: unknown;
};

export type AssistantChatMessage = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly AssistantChatPart[];
};

export type PendingConfirmation = StaffAssistantConfirmation & {
  readonly messageId: string;
};

export type ConfirmationCardState =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "proposed";
      readonly confirmation: PendingConfirmation;
    }
  | {
      readonly kind: "applying";
      readonly confirmation: PendingConfirmation;
    };

export type ConfirmationAppendPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "dynamic-tool";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly state: "output-available";
      readonly input: Record<string, never>;
      readonly output: unknown;
    };

export type ConfirmationConfirmRecoverability =
  "terminal" | "retryable" | "ambiguous";

export type ConfirmationConfirmResult =
  | {
      readonly status: "completed";
      readonly text: string;
      readonly actionName: string;
      readonly toolCallId: string;
      readonly output?: unknown;
      readonly httpStatus?: number;
      readonly recoverability: ConfirmationConfirmRecoverability;
    }
  | {
      readonly status: "expired";
      readonly httpStatus?: number;
      readonly recoverability: ConfirmationConfirmRecoverability;
    }
  | {
      readonly status: "error";
      readonly code?: string;
      readonly message?: string;
      readonly text?: string;
      readonly httpStatus?: number;
      readonly retryAfterSec?: number;
      readonly recoverability: ConfirmationConfirmRecoverability;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Façade / tool payload `{ status: "error", ... }` — not AI SDK `output-error`. */
export function isToolErrorOutput(output: unknown): boolean {
  return isRecord(output) && output.status === "error";
}

/**
 * Latest unignored `data-confirmation`. Ignored (dismissed/resolved) ids
 * are skipped so a later HITL card on a merged assistant message still
 * shows.
 */
export function pendingConfirmationFromMessages(
  messages: readonly AssistantChatMessage[],
  dismissedChallengeIds: ReadonlySet<string>,
): PendingConfirmation | null {
  let latest: PendingConfirmation | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      const confirmation = confirmationFromChatPart(part);
      if (confirmation === undefined) {
        continue;
      }
      if (dismissedChallengeIds.has(confirmation.challengeId)) {
        continue;
      }
      latest = { ...confirmation, messageId: message.id };
    }
  }
  return latest;
}

export function confirmationCardState(args: {
  readonly pending: PendingConfirmation | null;
  readonly resolvingChallengeId: string | null;
}): ConfirmationCardState {
  if (args.pending === null) {
    return { kind: "hidden" };
  }
  if (args.resolvingChallengeId === args.pending.challengeId) {
    return { kind: "applying", confirmation: args.pending };
  }
  return { kind: "proposed", confirmation: args.pending };
}

/**
 * Kept for old mobile builds that still `resume()` the chat transport.
 * Current confirm does not send this header.
 */
export function confirmationResumeHeaders(
  challengeId: string,
): Readonly<Record<string, string>> {
  return { [CONFIRMATION_CHALLENGE_HEADER]: challengeId };
}

/**
 * A failed HTTP 200 resume keeps the same `data-confirmation` part. Only
 * treat the challenge as consumed when the tool output is no longer that
 * confirmation and is not a tool error.
 */
export function confirmationResumeOutcome(args: {
  readonly challengeId: string;
  readonly toolCallId: string;
  readonly messages: readonly AssistantChatMessage[];
}): "open" | "succeeded" | "failed" {
  for (const message of args.messages) {
    for (const part of message.parts) {
      if (part.toolCallId !== args.toolCallId) {
        continue;
      }
      if (part.state === "output-error") {
        return "failed";
      }
      if (part.output === undefined) {
        continue;
      }
      const paused = confirmationFromChatPart(part.output);
      if (paused?.challengeId === args.challengeId) {
        continue;
      }
      if (isToolErrorOutput(part.output)) {
        return "failed";
      }
      return "succeeded";
    }
  }
  return "open";
}

/**
 * Mark resolved only when the resume consumed the challenge: the id is
 * gone from pending parts and there is no error, a newer confirmation
 * replaced it, or the matching tool result succeeded.
 */
export function shouldMarkConfirmationResolved(args: {
  readonly resolvingChallengeId: string;
  readonly pending: PendingConfirmation | null;
  readonly hasError: boolean;
  readonly messages: readonly AssistantChatMessage[];
}): boolean {
  if (args.hasError) {
    return false;
  }
  if (args.pending === null) {
    return true;
  }
  if (args.pending.challengeId !== args.resolvingChallengeId) {
    return true;
  }
  return (
    confirmationResumeOutcome({
      challengeId: args.resolvingChallengeId,
      toolCallId: args.pending.toolCallId,
      messages: args.messages,
    }) === "succeeded"
  );
}

/**
 * Claim the in-flight HITL resolve synchronously so two confirm() calls
 * cannot both POST. Same pattern as dismiss: a live ref.
 */
export function claimConfirmationConfirm(args: {
  readonly pending: PendingConfirmation | null;
  readonly sendBusy: boolean;
  readonly dismissedChallengeIds: ReadonlySet<string>;
  readonly resolvingRef: { current: string | null };
}): PendingConfirmation | null {
  if (args.pending === null || args.sendBusy) {
    return null;
  }
  if (args.dismissedChallengeIds.has(args.pending.challengeId)) {
    return null;
  }
  if (args.resolvingRef.current !== null) {
    return null;
  }
  args.resolvingRef.current = args.pending.challengeId;
  return args.pending;
}

export function confirmationConfirmShouldIgnoreChallenge(
  result: ConfirmationConfirmResult,
): boolean {
  return result.recoverability === "terminal";
}

export function presentConfirmationConfirmErrorText(
  result: ConfirmationConfirmResult,
  locale: "uk" | "en",
): string {
  if (typeof result.text === "string" && result.text.length > 0) {
    return result.text;
  }
  const copy = assistantCopy(locale);
  if (result.status === "expired") {
    return copy.confirmationExpired;
  }
  if (result.code === "UNAUTHENTICATED" || result.httpStatus === 401) {
    return copy.errors.unauthenticated;
  }
  if (result.code === "PERMISSION_DENIED" || result.httpStatus === 403) {
    return copy.errors.permission;
  }
  if (typeof result.message === "string" && result.message.length > 0) {
    return result.message;
  }
  return copy.errors.unavailable;
}

export function confirmationConfirmAppendParts(args: {
  readonly result: ConfirmationConfirmResult;
  readonly locale: "uk" | "en";
}): readonly ConfirmationAppendPart[] {
  if (args.result.status === "completed") {
    const parts: ConfirmationAppendPart[] = [
      { type: "text", text: args.result.text },
    ];
    if (args.result.output !== undefined) {
      parts.push({
        type: "dynamic-tool",
        toolName: args.result.actionName,
        toolCallId: args.result.toolCallId,
        state: "output-available",
        input: {},
        output: args.result.output,
      });
    }
    return parts;
  }
  if (
    args.result.status === "expired" ||
    (args.result.status === "error" &&
      args.result.recoverability === "terminal")
  ) {
    return [
      {
        type: "text",
        text: presentConfirmationConfirmErrorText(args.result, args.locale),
      },
    ];
  }
  return [];
}

export type CommitConfirmationConfirmResult = "skipped" | "stale" | "applied";

export function isCurrentAssistantConfirmationConfirm(args: {
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly resolvingRef: { readonly current: string | null };
  readonly challengeId: string;
}): boolean {
  return (
    args.companyEpochRef.current === args.epoch &&
    args.resolvingRef.current === args.challengeId
  );
}

export function commitConfirmationConfirmResult(args: {
  readonly result: ConfirmationConfirmResult | "skipped";
  readonly previousChallengeId: string;
  readonly locale: "uk" | "en";
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly resolvingRef: { readonly current: string | null };
  readonly appendParts: (parts: readonly ConfirmationAppendPart[]) => void;
  readonly ignoreChallenge: (challengeId: string) => void;
}): CommitConfirmationConfirmResult {
  if (args.result === "skipped") {
    return "skipped";
  }
  if (
    !isCurrentAssistantConfirmationConfirm({
      companyEpochRef: args.companyEpochRef,
      epoch: args.epoch,
      resolvingRef: args.resolvingRef,
      challengeId: args.previousChallengeId,
    })
  ) {
    return "stale";
  }
  const parts = confirmationConfirmAppendParts({
    result: args.result,
    locale: args.locale,
  });
  if (parts.length > 0) {
    args.appendParts(parts);
  }
  if (confirmationConfirmShouldIgnoreChallenge(args.result)) {
    args.ignoreChallenge(args.previousChallengeId);
  }
  return "applied";
}

/**
 * Confirm POSTs `/assistant/confirm`. Never sendMessage. Same-tick dismiss
 * is visible when `dismissedChallengeIds` is the live set (a ref).
 * `resolvingRef` is claimed synchronously before the POST await.
 */
export async function executeConfirmationConfirm(args: {
  readonly pending: PendingConfirmation | null;
  readonly sendBusy: boolean;
  readonly dismissedChallengeIds: ReadonlySet<string>;
  readonly resolvingRef: { current: string | null };
  readonly postConfirm: (input: {
    readonly challengeId: string;
  }) => Promise<ConfirmationConfirmResult>;
}): Promise<ConfirmationConfirmResult | "skipped"> {
  const claimed = claimConfirmationConfirm({
    pending: args.pending,
    sendBusy: args.sendBusy,
    dismissedChallengeIds: args.dismissedChallengeIds,
    resolvingRef: args.resolvingRef,
  });
  if (claimed === null) {
    return "skipped";
  }
  return args.postConfirm({ challengeId: claimed.challengeId });
}

export function executeConfirmationDismiss(args: {
  readonly pending: PendingConfirmation | null;
  readonly dismissed: ReadonlySet<string>;
}): ReadonlySet<string> {
  if (args.pending === null) {
    return args.dismissed;
  }
  const next = new Set(args.dismissed);
  next.add(args.pending.challengeId);
  return next;
}
