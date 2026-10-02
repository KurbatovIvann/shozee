import type { ChatPart, PublicPause, ToolOutcome } from "@showzy/assistant-kit";

import type {
  AssistantInteractionTypes,
  ChoiceResolution,
  ConfirmationResolution,
} from "./assistant-interactions.js";
import type {
  ConfirmedCardAction,
  ConfirmedCardFailure,
  ConfirmedCardResult,
} from "./assistant-kit-resolve.js";

export type AssistantTracePart = Extract<ChatPart, { readonly kind: "trace" }>;

type AssistantTraceAttempt = AssistantTracePart["attempts"][number];

const RECORD_ID_MAX = 128;

export function assistantTraceRecordId(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const direct = (result as Record<string, unknown>)["id"];
  return typeof direct === "string" ? storableId(direct) : null;
}

function storableId(value: string): string | null {
  return value.length > 0 && value.length <= RECORD_ID_MAX ? value : null;
}

const CHOICE_ENTITY_ID: keyof ChoiceResolution = "entityId";
const CONFIRMATION_ACTION: keyof ConfirmationResolution = "actionName";
const CONFIRMATION_ALSO: keyof ConfirmationResolution = "also";
const ATTEMPT_ACTION: keyof ConfirmedCardAction = "action";
const FAILURE_FIELDS: readonly (keyof ConfirmedCardFailure)[] = [
  "action",
  "code",
  "message",
];
const BUNDLE_DONE: keyof ConfirmedCardResult = "done";
const BUNDLE_FAILED: keyof ConfirmedCardResult = "failed";

function readText(value: unknown, field: string): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const read: unknown = (value as Record<string, unknown>)[field];
  return typeof read === "string" && read.length > 0 ? read : null;
}

function isConfirmedAction(value: unknown): value is ConfirmedCardAction {
  return readText(value, ATTEMPT_ACTION) !== null;
}

function isConfirmedFailure(value: unknown): value is ConfirmedCardFailure {
  return FAILURE_FIELDS.every((field) => readText(value, field) !== null);
}

function isConfirmedCardResult(result: unknown): result is ConfirmedCardResult {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const fields = result as Record<string, unknown>;
  const done = fields[BUNDLE_DONE];
  if (!Array.isArray(done) || !done.every(isConfirmedAction)) {
    return false;
  }
  const failed = fields[BUNDLE_FAILED];
  return failed === undefined || isConfirmedFailure(failed);
}

interface CloseArgs {
  readonly interactionId: string;
  readonly value: unknown;
  readonly outcome: ToolOutcome;
}

type Tracer = (args: CloseArgs) => readonly AssistantTracePart[];

function choiceTrace(args: CloseArgs): readonly AssistantTracePart[] {
  if (args.outcome.kind === "error") {
    return [];
  }
  const entityId = readText(args.value, CHOICE_ENTITY_ID);
  return [
    {
      kind: "trace",
      interactionId: args.interactionId,
      interactionKind: "choice",
      outcome: "chosen",
      optionId: entityId === null ? null : storableId(entityId),
      attempts: [],
    },
  ];
}

function isBundleResolution(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const also: unknown = (value as Record<string, unknown>)[CONFIRMATION_ALSO];
  return Array.isArray(also) && also.length > 0;
}

function bundleAttempts(result: unknown): AssistantTraceAttempt[] {
  if (!isConfirmedCardResult(result)) {
    return [];
  }
  const done = result.done.map((one): AssistantTraceAttempt => ({
    action: one.action,
    outcome: "done",
    recordId: assistantTraceRecordId(one.result),
  }));
  const failed = result.failed;
  return failed === undefined
    ? done
    : [...done, { action: failed.action, outcome: "failed", recordId: null }];
}

function singleAttempt(
  value: unknown,
  result: unknown,
): AssistantTraceAttempt[] {
  const action = readText(value, CONFIRMATION_ACTION);
  return action === null
    ? []
    : [{ action, outcome: "done", recordId: assistantTraceRecordId(result) }];
}

function confirmedAttempts(
  value: unknown,
  result: unknown,
): AssistantTraceAttempt[] {
  return isBundleResolution(value)
    ? bundleAttempts(result)
    : singleAttempt(value, result);
}

function confirmationTrace(args: CloseArgs): readonly AssistantTracePart[] {
  if (args.outcome.kind === "pause") {
    return [
      {
        kind: "trace",
        interactionId: args.interactionId,
        interactionKind: "confirmation",
        outcome: "superseded",
        optionId: null,
        attempts: [],
      },
    ];
  }
  if (args.outcome.kind !== "ok") {
    return [];
  }
  const attempts = confirmedAttempts(args.value, args.outcome.result);
  return [
    {
      kind: "trace",
      interactionId: args.interactionId,
      interactionKind: "confirmation",
      outcome: attempts.some((attempt) => attempt.outcome === "failed")
        ? "failed"
        : "done",
      optionId: null,
      attempts,
    },
  ];
}

const TRACERS: { readonly [K in keyof AssistantInteractionTypes]: Tracer } = {
  choice: choiceTrace,
  confirmation: confirmationTrace,
};

function isTracedKind(kind: string): kind is keyof AssistantInteractionTypes {
  return Object.hasOwn(TRACERS, kind);
}

export function assistantCloseTrace(
  args: CloseArgs & { readonly kind: string },
): readonly AssistantTracePart[] {
  return isTracedKind(args.kind) ? TRACERS[args.kind](args) : [];
}

export function assistantRejectedTrace(
  pause: Pick<PublicPause, "interactionId" | "kind">,
): AssistantTracePart {
  return {
    kind: "trace",
    interactionId: pause.interactionId,
    interactionKind: pause.kind,
    outcome: "rejected",
    optionId: null,
    attempts: [],
  };
}
