import type { ChatPart, PublicPause, ToolOutcome } from "@showzy/assistant-kit";

import type {
  AssistantInteractionTypes,
  ChoiceResolution,
  ConfirmationResolution,
} from "./assistant-interactions.js";
import type { ConfirmedCardResult } from "./assistant-kit-resolve.js";

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
  const resolution = args.value as ChoiceResolution;
  return [
    {
      kind: "trace",
      interactionId: args.interactionId,
      interactionKind: "choice",
      outcome: "chosen",
      optionId: storableId(resolution.entityId),
      attempts: [],
    },
  ];
}

function confirmedAttempts(
  resolution: ConfirmationResolution,
  result: unknown,
): AssistantTraceAttempt[] {
  if (resolution.also.length === 0) {
    return [
      {
        action: resolution.actionName,
        outcome: "done",
        recordId: assistantTraceRecordId(result),
      },
    ];
  }
  const bundle = result as ConfirmedCardResult;
  const done = bundle.done.map((one): AssistantTraceAttempt => ({
    action: one.action,
    outcome: "done",
    recordId: assistantTraceRecordId(one.result),
  }));
  const failed = bundle.failed;
  return failed === undefined
    ? done
    : [...done, { action: failed.action, outcome: "failed", recordId: null }];
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
  const attempts = confirmedAttempts(
    args.value as ConfirmationResolution,
    args.outcome.result,
  );
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
