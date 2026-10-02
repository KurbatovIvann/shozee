/**
 * The confirmation half: an action that will not run without a person's
 * say-so, paused inside a turn and resumed through the domain's own protocol.
 *
 * Core already owns that protocol for every channel (core.md §7). A
 * `requiresConfirmation` action refuses its first call with a single-use
 * challenge bound to the action, the hash of its input, the person, the company
 * and the idempotency key of the attempt, and runs only when that same attempt is
 * presented again with the challenge. The assistant goes through it, not around
 * it: the model can ask, only a person's tap can resume, and core checks the tap
 * exactly as it checks one from a form.
 *
 * What this file adds is the part core cannot know — that the refusal happened
 * inside a model turn and has to become a question. The facts core bound the
 * challenge to travel with the pause, server-side. A resume that recomputed any
 * of them from the answer's own request would be a different attempt, and core
 * would ask again rather than run.
 */
import type { ToolOutcome } from "@showzy/assistant-kit";
import type { ActionRisk, ConfirmableRisk } from "@showzy/core/contract";
import { isConfirmableRisk } from "@showzy/core/contract";
import type {
  ConfirmationChallenge,
  ConfirmationRequiredError,
  CoreErrorCode,
} from "@showzy/core/errors";
import type {
  AssistantPreview,
  AssistantPreviewLevel,
} from "@showzy/validation/assistant-chat";

import type {
  ConfirmationAlsoSecret,
  ConfirmationAttemptSecret,
  ConfirmationSecret,
} from "./assistant-interactions.js";

/** What the server supplied to the call core challenged. */
export interface ConfirmationAttempt {
  readonly actionName: string;
  /** The object `executeAction` received, whose hash the challenge carries. */
  readonly input: unknown;
  readonly idempotencyKey: string;
}

/**
 * Core refused an assistant call pending a person's authorisation.
 *
 * Thrown where the call was made, because only that frame has the attempt in
 * hand: core's own error carries the challenge and nothing about what it was
 * issued for.
 */
export class AssistantConfirmationRequired extends Error {
  readonly attempt: ConfirmationAttempt;
  readonly challenge: ConfirmationChallenge;
  readonly code: CoreErrorCode;
  readonly clientMessage: string;
  readonly level: AssistantPreviewLevel;

  constructor(
    attempt: ConfirmationAttempt,
    refused: ConfirmationRequiredError,
    level: AssistantPreviewLevel = "card",
  ) {
    super(`"${attempt.actionName}" requires confirmation`);
    this.name = "AssistantConfirmationRequired";
    this.attempt = attempt;
    this.challenge = refused.challenge;
    this.code = refused.code;
    this.clientMessage = refused.clientMessage;
    this.level = level;
  }
}

const CONFIRMABLE_RISK_LEVELS: Record<ConfirmableRisk, AssistantPreviewLevel> =
  {
    high: "strong",
    write: "card",
  };

export function assistantPreviewLevel(
  risk: ActionRisk,
): AssistantPreviewLevel | undefined {
  return isConfirmableRisk(risk) ? CONFIRMABLE_RISK_LEVELS[risk] : undefined;
}

function previewOf(required: AssistantConfirmationRequired): AssistantPreview {
  const card = required.challenge.preview;
  if (card === undefined) {
    return { title: required.challenge.summary, lines: [], notes: [] };
  }
  return {
    title: card.title,
    lines: card.lines.map((line) => ({ label: line.label, value: line.value })),
    notes: [...(card.notes ?? [])],
  };
}

function attemptSecretOf(
  required: AssistantConfirmationRequired,
): ConfirmationAttemptSecret {
  return {
    actionName: required.attempt.actionName,
    canonicalInput: required.attempt.input,
    idempotencyKey: required.attempt.idempotencyKey,
    challengeId: required.challenge.challengeId,
  };
}

/**
 * The question a person is asked. The prompt is core's redacted summary and
 * nothing more; the attempt and the challenge stay in the secret, which never
 * leaves the server.
 */
export function confirmationAlso(
  required: AssistantConfirmationRequired,
): ConfirmationAlsoSecret {
  return {
    ...attemptSecretOf(required),
    preview: previewOf(required),
    level: required.level,
  };
}

export function confirmationPause(
  required: AssistantConfirmationRequired,
  also: readonly ConfirmationAlsoSecret[] = [],
): Extract<ToolOutcome, { kind: "pause" }> {
  const secret: ConfirmationSecret = { ...attemptSecretOf(required), also };
  const strong =
    required.level === "strong" || also.some((one) => one.level === "strong");
  return {
    kind: "pause",
    interaction: "confirmation",
    prompt: {
      summary: required.challenge.summary,
      preview: previewOf(required),
      also: also.map((one) => one.preview),
      level: strong ? "strong" : "card",
    },
    secret,
  };
}
