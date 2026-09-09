/**
 * HITL ChoiceCard presenter (SHO-418). Tap POSTs `{ conversationId,
 * choiceId, optionId }` only — no canonical input, target, or mapping.
 * Resume does not call the LLM.
 */
import { z } from "zod";

import { assistantCopy } from "../../../i18n/assistant";
import {
  isCurrentAssistantChoiceSelect,
  type AssistantCompanyEpochRef,
} from "./assistant-session";
import {
  claimedRetryOptionId,
  choiceFromChatPart,
  envelopeFromChoicePeek,
  isRestorableChoiceStatus,
  staffAssistantChoiceCardEnvelopeSchema,
  type StaffAssistantChoiceCardEnvelope,
} from "./choice";
import {
  partsFromResumeEnvelope,
  type AssistantHostInteractionResult,
  type AssistantResumeEnvelope,
  type ResumeAppendPart,
} from "./resume-envelope";

export type AssistantChoicePart = {
  readonly type: string;
  readonly text?: string;
  readonly data?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly output?: unknown;
};

export type AssistantChoiceMessage = {
  readonly id: string;
  readonly role: string;
  readonly parts: readonly AssistantChoicePart[];
};

export type PendingChoice = StaffAssistantChoiceCardEnvelope & {
  readonly messageId: string;
  readonly pendingVersion?: number;
};

export type ChoiceCardState =
  | { readonly kind: "hidden" }
  | {
      readonly kind: "proposed";
      readonly choice: PendingChoice;
    }
  | {
      readonly kind: "applying";
      readonly choice: PendingChoice;
    };

export type ChoiceSelectRecoverability = "retryable" | "terminal" | "ambiguous";

export type ChoiceAttemptedOption = {
  readonly challengeId: string;
  readonly optionId: string;
};

export type ChoiceSelectResult = {
  readonly status: string;
  readonly text?: string | undefined;
  readonly challengeId?: string | undefined;
  readonly reason?: string | undefined;
  readonly choiceKind?: "variant" | "product" | "customer" | undefined;
  readonly productName?: string | undefined;
  readonly options?:
    readonly { readonly id: string; readonly label: string }[] | undefined;
  readonly optionsTruncated?: boolean | undefined;
  readonly entity?:
    { readonly orderId: string; readonly orderNumber: string } | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly retryAfterSec?: number | undefined;
  readonly recoverability?: ChoiceSelectRecoverability | undefined;
  readonly envelope?: AssistantResumeEnvelope | undefined;
};

const orderIdSchema = z.uuid();

const TERMINAL_INTERACTION_CODES = new Set([
  "CHOICE_OPTION_CONFLICT",
  "CHOICE_INVALID_OPTION",
]);

const TERMINAL_WIRE_CODES = new Set([
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "IDEMPOTENCY_CONFLICT",
]);

const RETRYABLE_WIRE_CODES = new Set([
  "RETRY_IN_PROGRESS",
  "RATE_LIMITED",
  "INTERNAL",
  "TIMEOUT",
]);

function httpStatusRecoverability(
  httpStatus: number,
): ChoiceSelectRecoverability | undefined {
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    httpStatus === 400 ||
    httpStatus === 404 ||
    httpStatus === 422
  ) {
    return "terminal";
  }
  if (
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504 ||
    (httpStatus >= 500 && httpStatus <= 599)
  ) {
    return "retryable";
  }
  if (httpStatus === 409) {
    return undefined;
  }
  return undefined;
}

function completedSelectIsValid(result: ChoiceSelectResult): boolean {
  if (typeof result.text !== "string" || result.text.length === 0) {
    return false;
  }
  const entity = result.entity;
  if (entity === undefined) {
    return false;
  }
  return (
    orderIdSchema.safeParse(entity.orderId).success &&
    typeof entity.orderNumber === "string" &&
    entity.orderNumber.length > 0
  );
}

function interactionErrorIsValid(result: ChoiceSelectResult): boolean {
  return (
    result.status === "error" &&
    result.httpStatus === 200 &&
    typeof result.code === "string" &&
    result.code.length > 0 &&
    typeof result.message === "string" &&
    result.message.length > 0
  );
}

/**
 * Host `POST /assistant/choice` domain errors are HTTP 200
 * `{ status: "error", code }`. Phase A CoreError after claim uses this
 * shape and leaves Redis `claimed`. Wire HTTP 400/404 VALIDATION /
 * NOT_FOUND must not keep a ghost picker (SHO-545).
 */
function keepsPendingVisibleOnDomainError(result: ChoiceSelectResult): boolean {
  if (result.status !== "error") {
    return false;
  }
  if (typeof result.code !== "string" || result.code.length === 0) {
    return false;
  }
  if (result.httpStatus === 200) {
    return true;
  }
  return (
    result.httpStatus === undefined && !TERMINAL_WIRE_CODES.has(result.code)
  );
}

/**
 * Hide the old picker only when the envelope proves the record is gone
 * or a successor picker replaced it. Bare `{ status: "error" }` after
 * claim is not enough (SHO-545).
 */
function choiceSelectEnvelopeRetiresChallenge(
  result: ChoiceSelectResult,
): boolean {
  if (result.status === "expired") {
    return true;
  }
  if (result.status === "needs_choice") {
    return needsChoiceInteractionIsValid(result);
  }
  return result.envelope?.pending === null;
}

/**
 * Classify a choice POST outcome from real server codes and HTTP status.
 * HTTP 200 `{ status: "error" }` after claim leaves pending claimed —
 * same-option retry, not a terminal hide. Outer-wire 401/403/404 before
 * claim may still be terminal. 409 is retryable only for
 * `RETRY_IN_PROGRESS`, not every conflict.
 */
export function deriveChoiceSelectRecoverability(
  result: ChoiceSelectResult,
): ChoiceSelectRecoverability {
  if (result.status === "ok") {
    return "terminal";
  }
  if (result.status === "completed") {
    return completedSelectIsValid(result) ? "terminal" : "ambiguous";
  }
  if (result.status === "expired") {
    return "terminal";
  }
  if (result.status === "needs_choice") {
    return needsChoiceInteractionIsValid(result) ? "terminal" : "ambiguous";
  }
  if (typeof result.code === "string") {
    if (RETRYABLE_WIRE_CODES.has(result.code)) {
      return "retryable";
    }
    if (keepsPendingVisibleOnDomainError(result)) {
      return "retryable";
    }
    if (TERMINAL_WIRE_CODES.has(result.code)) {
      return "terminal";
    }
  }
  if (interactionErrorIsValid(result)) {
    return "retryable";
  }
  if (typeof result.httpStatus === "number") {
    const fromHttp = httpStatusRecoverability(result.httpStatus);
    if (fromHttp !== undefined) {
      return fromHttp;
    }
  }
  return "ambiguous";
}

export function classifyChoiceSelect(
  result: ChoiceSelectResult,
): ChoiceSelectRecoverability {
  return result.recoverability ?? deriveChoiceSelectRecoverability(result);
}

export function choiceSelectAllowsSameOptionRetry(
  result: ChoiceSelectResult,
): boolean {
  const recoverability = classifyChoiceSelect(result);
  return recoverability === "retryable" || recoverability === "ambiguous";
}

export type ChoiceAppendPart = ResumeAppendPart;

function choiceEnvelopeIsRestorable(
  status: StaffAssistantChoiceCardEnvelope["status"],
): boolean {
  return isRestorableChoiceStatus(status);
}

/**
 * Latest open picker (`needs_choice`), claimed recovery, or expired copy.
 * Completed peeks are not a ChoiceCard — the later successful entity turn
 * hydrates on its own. Ignored ids skip tappable `needs_choice` / `claimed`
 * so a sequential successor still shows. Expired copy for a consumed
 * challenge stays visible (hydrate `{ status: "expired" }` peek, and POST
 * `{ status: "expired" }`). Temporary peek failures are omitted, not
 * expired.
 */
export function pendingChoiceFromMessages(
  messages: readonly AssistantChoiceMessage[],
  ignoredChallengeIds: ReadonlySet<string>,
): PendingChoice | null {
  let latest: PendingChoice | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      const choice = choiceFromChatPart(part);
      if (choice === undefined) {
        continue;
      }
      if (!choiceEnvelopeIsRestorable(choice.status)) {
        continue;
      }
      if (
        (choice.status === "needs_choice" || choice.status === "claimed") &&
        ignoredChallengeIds.has(choice.challengeId)
      ) {
        continue;
      }
      const pendingVersion = pendingVersionFromChoicePart(part);
      latest = {
        ...choice,
        messageId: message.id,
        ...(pendingVersion === undefined ? {} : { pendingVersion }),
      };
    }
  }
  return latest;
}

export function choiceCardState(args: {
  readonly pending: PendingChoice | null;
  readonly resolvingChallengeId: string | null;
}): ChoiceCardState {
  if (
    args.pending === null ||
    !choiceEnvelopeIsRestorable(args.pending.status)
  ) {
    return { kind: "hidden" };
  }
  if (args.resolvingChallengeId === args.pending.challengeId) {
    return { kind: "applying", choice: args.pending };
  }
  return { kind: "proposed", choice: args.pending };
}

function attemptedOptionIdForChoice(
  choice: StaffAssistantChoiceCardEnvelope,
  attempted: ChoiceAttemptedOption | null | undefined,
): string | undefined {
  if (
    attempted === null ||
    attempted === undefined ||
    attempted.challengeId !== choice.challengeId
  ) {
    return undefined;
  }
  if (!choice.options.some((option) => option.id === attempted.optionId)) {
    return undefined;
  }
  return attempted.optionId;
}

/**
 * Same-option recovery id for claimed peeks and for an uncertain POST
 * that still shows `needs_choice`. Until authoritative state proves
 * otherwise, only this option may be retried.
 */
export function choiceCardRetryOptionId(args: {
  readonly choice: StaffAssistantChoiceCardEnvelope;
  readonly attempted?: ChoiceAttemptedOption | null;
}): string | undefined {
  const claimedId = claimedRetryOptionId(args.choice);
  if (claimedId !== undefined) {
    return claimedId;
  }
  if (args.choice.status !== "needs_choice") {
    return undefined;
  }
  return attemptedOptionIdForChoice(args.choice, args.attempted);
}

/**
 * Tappable picker options. After an uncertain POST of A, B is not
 * offered while the remembered attempt still matches this challenge.
 */
/**
 * Dismiss stays on the retry/claimed card so a keep-pending Phase A
 * error is not Redis-TTL-only. Abandon is still
 * `POST /assistant/pending/abandon`. Expired copy has nothing to abandon.
 */
export function choiceCardShowsDismiss(args: {
  readonly choice: StaffAssistantChoiceCardEnvelope;
  readonly applying: boolean;
}): boolean {
  if (args.applying) {
    return false;
  }
  if (args.choice.status === "expired") {
    return false;
  }
  return (
    args.choice.status === "needs_choice" || args.choice.status === "claimed"
  );
}

export function choiceCardOfferedOptions(args: {
  readonly choice: StaffAssistantChoiceCardEnvelope;
  readonly attempted?: ChoiceAttemptedOption | null;
}): readonly { readonly id: string; readonly label: string }[] {
  if (args.choice.status !== "needs_choice") {
    return [];
  }
  const locked = attemptedOptionIdForChoice(args.choice, args.attempted);
  if (locked === undefined) {
    return args.choice.options;
  }
  return args.choice.options.filter((option) => option.id === locked);
}

function choiceSelectOptionAllowed(
  pending: PendingChoice,
  optionId: string,
  attempted?: ChoiceAttemptedOption | null,
): boolean {
  if (pending.status === "claimed") {
    return claimedRetryOptionId(pending) === optionId;
  }
  if (pending.status !== "needs_choice") {
    return false;
  }
  if (!pending.options.some((option) => option.id === optionId)) {
    return false;
  }
  if (
    attempted !== null &&
    attempted !== undefined &&
    attempted.challengeId === pending.challengeId
  ) {
    return optionId === attempted.optionId;
  }
  return true;
}

export function canSelectChoiceOption(args: {
  readonly pending: PendingChoice | null;
  readonly optionId: string;
  readonly attempted?: ChoiceAttemptedOption | null;
}): boolean {
  if (args.pending === null) {
    return false;
  }
  return choiceSelectOptionAllowed(args.pending, args.optionId, args.attempted);
}

/**
 * Claim the in-flight option synchronously so duplicate and different-
 * option taps skip before POST. `resolvingRef` is the live lock.
 * Claimed recovery may retry only the already-claimed opaque option.
 */
export function claimChoiceSelect(args: {
  readonly pending: PendingChoice | null;
  readonly optionId: string;
  readonly resolvingRef: { current: string | null };
  readonly attempted?: ChoiceAttemptedOption | null;
}): PendingChoice | null {
  if (args.pending === null) {
    return null;
  }
  if (!choiceSelectOptionAllowed(args.pending, args.optionId, args.attempted)) {
    return null;
  }
  if (args.resolvingRef.current !== null) {
    return null;
  }
  args.resolvingRef.current = args.pending.challengeId;
  return args.pending;
}

export async function executeChoiceSelect(args: {
  readonly pending: PendingChoice | null;
  readonly optionId: string;
  readonly resolvingRef: { current: string | null };
  readonly attempted?: ChoiceAttemptedOption | null;
  readonly postChoice: (input: {
    readonly choiceId: string;
    readonly optionId: string;
  }) => Promise<ChoiceSelectResult>;
}): Promise<ChoiceSelectResult | "skipped"> {
  const claimed = claimChoiceSelect({
    pending: args.pending,
    optionId: args.optionId,
    resolvingRef: args.resolvingRef,
    ...(args.attempted === undefined ? {} : { attempted: args.attempted }),
  });
  if (claimed === null) {
    return "skipped";
  }
  return args.postChoice({
    choiceId: claimed.challengeId,
    optionId: args.optionId,
  });
}

function needsChoiceEnvelopeFromSelectResult(
  result: ChoiceSelectResult,
): StaffAssistantChoiceCardEnvelope | undefined {
  if (result.status !== "needs_choice") {
    return undefined;
  }
  if (typeof result.optionsTruncated !== "boolean") {
    return undefined;
  }
  if (result.options === undefined) {
    return undefined;
  }
  const parsed = staffAssistantChoiceCardEnvelopeSchema.safeParse({
    status: "needs_choice",
    challengeId: result.challengeId,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(result.choiceKind === "variant" ||
    result.choiceKind === "product" ||
    result.choiceKind === "customer"
      ? { choiceKind: result.choiceKind }
      : {}),
    ...(typeof result.productName === "string"
      ? { productName: result.productName }
      : {}),
    options: result.options,
    optionsTruncated: result.optionsTruncated,
  });
  return parsed.success ? parsed.data : undefined;
}

function needsChoiceInteractionIsValid(result: ChoiceSelectResult): boolean {
  if (typeof result.text !== "string" || result.text.length === 0) {
    return false;
  }
  const envelope = needsChoiceEnvelopeFromSelectResult(result);
  if (envelope === undefined) {
    return false;
  }
  return envelope.options.length > 0;
}

export function choiceSelectRememberedAttempt(args: {
  readonly result: ChoiceSelectResult | "skipped";
  readonly challengeId: string;
  readonly optionId: string;
  readonly previous: ChoiceAttemptedOption | null;
}): ChoiceAttemptedOption | null {
  // A skipped B tap must not wipe the remembered A attempt.
  if (args.result === "skipped") {
    return args.previous;
  }
  // Bare option-conflict after a keep-pending claim is not a successor.
  // Do not lock retry to the conflicting tap (B) while Redis still has A.
  if (
    typeof args.result.code === "string" &&
    TERMINAL_INTERACTION_CODES.has(args.result.code) &&
    !choiceSelectShouldIgnoreChallenge(args.result)
  ) {
    return args.previous;
  }
  if (!choiceSelectAllowsSameOptionRetry(args.result)) {
    return null;
  }
  return {
    challengeId: args.challengeId,
    optionId: args.optionId,
  };
}

/**
 * Hide the picker only when the host proves the old record is gone
 * (expired / `pending: null`), a successor `needs_choice` opened, a
 * completed resume landed, or outer-wire 401/403/404 happened before
 * claim. HTTP 200 `{ status: "error" }` after claim keeps the card.
 */
export function choiceSelectShouldIgnoreChallenge(
  result: ChoiceSelectResult,
): boolean {
  if (result.status === "ok") {
    return true;
  }
  if (result.status === "completed") {
    return completedSelectIsValid(result);
  }
  if (choiceSelectEnvelopeRetiresChallenge(result)) {
    return true;
  }
  if (keepsPendingVisibleOnDomainError(result)) {
    return false;
  }
  if (interactionErrorIsValid(result)) {
    return false;
  }
  return classifyChoiceSelect(result) === "terminal";
}

function choiceSelectShouldAppendErrorSpeech(
  result: ChoiceSelectResult,
): boolean {
  if (result.status !== "error") {
    return false;
  }
  if (choiceSelectShouldIgnoreChallenge(result)) {
    return true;
  }
  return (
    keepsPendingVisibleOnDomainError(result) || interactionErrorIsValid(result)
  );
}

/**
 * Visible copy after a terminal `{ status: "error" }` POST body. Prefer
 * `text`, then distinct auth/permission copy from the real wire code,
 * then the HTTP `message` (`CHOICE_OPTION_CONFLICT` /
 * `CHOICE_INVALID_OPTION`), then existing assistant unavailable copy.
 * Never sendMessage. Never surface confirmation challenge tokens.
 */
export function presentChoiceSelectErrorText(
  result: ChoiceSelectResult,
  locale: "uk" | "en",
): string {
  if (typeof result.text === "string" && result.text.length > 0) {
    return result.text;
  }
  const copy = assistantCopy(locale);
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

/**
 * Local append after POST /assistant/choice. Never sendMessage — resume
 * must not call the LLM. Sequential `needs_choice` speech is the server
 * `text` (SHO-427); do not invent a second bubble from the envelope.
 */
export function choiceSelectAppendParts(args: {
  readonly result: ChoiceSelectResult;
  readonly previousChoiceId: string;
  readonly locale: "uk" | "en";
}): readonly ChoiceAppendPart[] {
  if (args.result.envelope !== undefined) {
    return partsFromResumeEnvelope(args.result.envelope);
  }
  if (args.result.status === "completed") {
    if (!completedSelectIsValid(args.result)) {
      return [];
    }
    const text = args.result.text;
    const entity = args.result.entity;
    if (typeof text !== "string" || entity === undefined) {
      return [];
    }
    return [
      { type: "text", text },
      {
        type: "dynamic-tool",
        toolName: "orders.create",
        toolCallId: `choice_${args.previousChoiceId}`,
        state: "output-available",
        input: {},
        output: {
          orderId: entity.orderId,
          orderNumber: entity.orderNumber,
        },
      },
    ];
  }
  if (args.result.status === "needs_choice") {
    if (!needsChoiceInteractionIsValid(args.result)) {
      return [];
    }
    const envelope = needsChoiceEnvelopeFromSelectResult(args.result);
    const text = args.result.text;
    if (envelope === undefined || typeof text !== "string") {
      return [];
    }
    return [
      { type: "text", text },
      { type: "data-choice", data: envelope },
    ];
  }
  if (args.result.status === "expired") {
    const expired = envelopeFromChoicePeek(
      args.previousChoiceId,
      args.result,
    ) ?? {
      status: "expired" as const,
      challengeId: args.previousChoiceId,
      options: [],
      optionsTruncated: false,
    };
    return [
      {
        type: "data-choice",
        data: expired,
      },
    ];
  }
  if (choiceSelectShouldAppendErrorSpeech(args.result)) {
    return [
      {
        type: "text",
        text: presentChoiceSelectErrorText(args.result, args.locale),
      },
    ];
  }
  return [];
}

export type CommitChoiceSelectResult = "skipped" | "stale" | "applied";

/**
 * Apply a POST /assistant/choice body onto the current tenant session.
 * Append first so an expired envelope is in `messages` before ignore
 * skips the tappable `needs_choice`. HTTP 200 domain errors append
 * speech and keep the original challenge for same-option retry.
 * Drop ignore + append when the company epoch moved or `reset()` cleared
 * the resolving lock.
 */
export function commitChoiceSelectResult(args: {
  readonly result: ChoiceSelectResult | "skipped";
  readonly previousChoiceId: string;
  readonly locale: "uk" | "en";
  readonly companyEpochRef: AssistantCompanyEpochRef;
  readonly epoch: number;
  readonly resolvingRef: { readonly current: string | null };
  readonly appendParts: (parts: readonly ChoiceAppendPart[]) => void;
  readonly ignoreChallenge: (challengeId: string) => void;
}): CommitChoiceSelectResult {
  if (args.result === "skipped") {
    return "skipped";
  }
  if (
    !isCurrentAssistantChoiceSelect({
      companyEpochRef: args.companyEpochRef,
      epoch: args.epoch,
      resolvingRef: args.resolvingRef,
      challengeId: args.previousChoiceId,
    })
  ) {
    return "stale";
  }
  const parts = choiceSelectAppendParts({
    result: args.result,
    previousChoiceId: args.previousChoiceId,
    locale: args.locale,
  });
  if (parts.length > 0) {
    args.appendParts(parts);
  }
  if (choiceSelectShouldIgnoreChallenge(args.result)) {
    args.ignoreChallenge(args.previousChoiceId);
  }
  return "applied";
}

function pendingVersionFromUnknown(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!("pendingVersion" in value)) {
    return undefined;
  }
  const version = value.pendingVersion;
  if (typeof version === "number" && Number.isInteger(version) && version > 0) {
    return version;
  }
  return undefined;
}

function pendingVersionFromChoicePart(
  part: AssistantChoicePart,
): number | undefined {
  return (
    pendingVersionFromUnknown(part.data) ?? pendingVersionFromUnknown(part)
  );
}

export function hideChoiceLocally(args: {
  readonly pending: PendingChoice | null;
  readonly dismissed: ReadonlySet<string>;
}): ReadonlySet<string> {
  if (args.pending === null) {
    return args.dismissed;
  }
  const next = new Set(args.dismissed);
  next.add(args.pending.challengeId);
  return next;
}

export async function executeChoiceAbandon(args: {
  readonly pending: PendingChoice | null;
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
