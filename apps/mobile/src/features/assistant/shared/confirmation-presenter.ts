/**
 * HITL card presenter for the staff assistant (SHO-323 / SHO-522).
 *
 * Live sheet (until T5): confirm is `sendMessage` +
 * `x-confirmation-challenge-id`. Host presenters (unpublished
 * `createStaffAssistantHostApp`) POST `/assistant/confirm` and abandon
 * via injected ports. Local hide without abandon is not the host card
 * path.
 */
import { CONFIRMATION_CHALLENGE_HEADER } from "@showzy/contract";

import {
  confirmationFromChatPart,
  type StaffAssistantConfirmation,
} from "./confirmation";
import {
  shouldHidePendingCardAfterAbandon,
  type AssistantHostInteractionResult,
} from "./resume-envelope";

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
  readonly pendingVersion?: number;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pendingVersionFromPart(part: AssistantChatPart): number | undefined {
  const candidates: unknown[] = [part.data, part];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const version = candidate.pendingVersion;
    if (
      typeof version === "number" &&
      Number.isInteger(version) &&
      version > 0
    ) {
      return version;
    }
  }
  return undefined;
}

/** Façade / tool payload `{ status: "error", ... }` — not AI SDK `output-error`. */
export function isToolErrorOutput(output: unknown): boolean {
  return isRecord(output) && output.status === "error";
}

/**
 * Latest unignored `data-confirmation`. Ignored (dismissed/resolved) ids
 * are skipped so a later HITL card on a merged assistant message still
 * shows (AI SDK 7 resume merge + core.md §7).
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
      const pendingVersion = pendingVersionFromPart(part);
      latest = {
        ...confirmation,
        messageId: message.id,
        ...(pendingVersion === undefined ? {} : { pendingVersion }),
      };
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
 * before `sendBusy` cannot both POST. Same pattern as dismiss: a live ref.
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

/**
 * Live confirm until T5: resume the chat with the challenge header.
 * Never POST unpublished `/assistant/confirm` from the production sheet.
 */
export async function executeConfirmationConfirm(args: {
  readonly pending: PendingConfirmation | null;
  readonly sendBusy: boolean;
  readonly dismissedChallengeIds: ReadonlySet<string>;
  readonly resolvingRef: { current: string | null };
  readonly resume: (headers: Readonly<Record<string, string>>) => Promise<void>;
}): Promise<"resumed" | "skipped"> {
  const claimed = claimConfirmationConfirm({
    pending: args.pending,
    sendBusy: args.sendBusy,
    dismissedChallengeIds: args.dismissedChallengeIds,
    resolvingRef: args.resolvingRef,
  });
  if (claimed === null) {
    return "skipped";
  }
  await args.resume(confirmationResumeHeaders(claimed.challengeId));
  return "resumed";
}

/**
 * Unpublished-host confirm: POST `/assistant/confirm` with conversation
 * + challenge ids. Injected ports only — not the live sheet.
 */
export async function executeHostConfirmationConfirm(args: {
  readonly pending: PendingConfirmation | null;
  readonly sendBusy: boolean;
  readonly dismissedChallengeIds: ReadonlySet<string>;
  readonly resolvingRef: { current: string | null };
  readonly conversationId: string | null;
  readonly postConfirm: (input: {
    readonly conversationId: string;
    readonly challengeId: string;
  }) => Promise<AssistantHostInteractionResult>;
}): Promise<"skipped" | AssistantHostInteractionResult> {
  const claimed = claimConfirmationConfirm({
    pending: args.pending,
    sendBusy: args.sendBusy,
    dismissedChallengeIds: args.dismissedChallengeIds,
    resolvingRef: args.resolvingRef,
  });
  if (claimed === null || args.conversationId === null) {
    return "skipped";
  }
  return args.postConfirm({
    conversationId: args.conversationId,
    challengeId: claimed.challengeId,
  });
}

/**
 * Live confirmation dismiss until T5. Host card dismiss must call
 * `executeConfirmationAbandon` instead.
 */
export function executeConfirmationDismiss(args: {
  readonly pending: PendingConfirmation | null;
  readonly dismissed: ReadonlySet<string>;
}): ReadonlySet<string> {
  return hideConfirmationLocally(args);
}

/**
 * Local hide only — not the unpublished-host confirmation card path.
 */
export function hideConfirmationLocally(args: {
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

export async function executeConfirmationAbandon(args: {
  readonly pending: PendingConfirmation | null;
  readonly conversationId: string | null;
  readonly pendingVersion: number | undefined;
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
}): Promise<"skipped" | AssistantHostInteractionResult> {
  if (args.pending === null || args.conversationId === null) {
    return "skipped";
  }
  let version = args.pendingVersion ?? args.pending.pendingVersion;
  if (version === undefined) {
    const peeked = await args.peekPending();
    if (peeked.kind === "unavailable") {
      return {
        status: "error",
        code: "UNAVAILABLE",
        message: "Pending lookup is not available.",
      };
    }
    if (
      peeked.pending === null ||
      peeked.pending.id !== args.pending.challengeId
    ) {
      return { status: "expired" };
    }
    version = peeked.pending.version;
  }
  return args.postAbandon({
    conversationId: args.conversationId,
    pendingId: args.pending.challengeId,
    expectedVersion: version,
  });
}

export { shouldHidePendingCardAfterAbandon };
