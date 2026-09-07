/**
 * Visible-reply sanitization for the staff assistant (SHO-507).
 *
 * The model streams plain text. Candidate reply text is held until final
 * presenter selection; this module never parses `{ "spoken": ... }` JSON
 * to recover prose. Cards stay a projection of tool parts (ADR-0011).
 * Surface `promptLine`s live in `@showzy/validation/assistant-surfaces`.
 */
import { STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT } from "./confirmation.js";

/**
 * Short product-language line when spoken is empty or a markdown dump
 * after a successful tool turn. Never "Done." for a successful list.
 */
export const STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK =
  "Here is a short summary of the result.";

/**
 * Persist/stream fallback when a tool run failed and the model produced
 * no usable reply. Never `"Done."` after a tool error (SHO-429).
 */
export const STAFF_ASSISTANT_TOOL_ERROR_FALLBACK =
  "The assistant could not complete this turn.";

type SpokenTurnRun = {
  readonly outcome:
    "success" | "error" | "confirmation_required" | "choice_required";
};

type SpokenStreamPart = {
  readonly type: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStaffAssistantTypedToolError(value: unknown): boolean {
  return (
    isRecord(value) &&
    value["status"] === "error" &&
    typeof value["code"] === "string"
  );
}

export function staffAssistantTypedToolErrorMessage(
  output: unknown,
): string | undefined {
  if (!isStaffAssistantTypedToolError(output) || !isRecord(output)) {
    return undefined;
  }
  const message = output["message"];
  if (typeof message !== "string") {
    return undefined;
  }
  const trimmed = message.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function lastStaffAssistantTypedToolErrorMessage(
  outputs: readonly unknown[],
): string | undefined {
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const message = staffAssistantTypedToolErrorMessage(outputs[index]);
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

export function spokenContainsMarkdownDump(spoken: string): boolean {
  return (
    spoken.includes("|") || spoken.includes("**") || spoken.includes("```")
  );
}

function looksLikeJsonObject(text: string): boolean {
  return text.trimStart().startsWith("{");
}

function turnHasHitlPause(runs: readonly SpokenTurnRun[]): boolean {
  return runs.some(
    (run) =>
      run.outcome === "confirmation_required" ||
      run.outcome === "choice_required",
  );
}

function typedToolErrorSpokenFallback(
  toolErrorMessage: string | undefined,
): string {
  const fallback = toolErrorMessage?.trim();
  if (fallback !== undefined && fallback !== "") {
    return fallback;
  }
  return STAFF_ASSISTANT_TOOL_ERROR_FALLBACK;
}

function spokenMarkdownDumpFallback(
  runs: readonly SpokenTurnRun[],
  toolErrorMessage: string | undefined,
): string {
  if (turnHasHitlPause(runs)) {
    return STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT;
  }
  if (runs.some((run) => run.outcome === "error")) {
    return typedToolErrorSpokenFallback(toolErrorMessage);
  }
  return STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK;
}

function spokenFallbackFromRuns(
  runs: readonly SpokenTurnRun[],
  toolErrorMessage: string | undefined,
): string {
  if (turnHasHitlPause(runs)) {
    return STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT;
  }
  if (runs.some((run) => run.outcome === "error")) {
    return typedToolErrorSpokenFallback(toolErrorMessage);
  }
  if (runs.some((run) => run.outcome === "success")) {
    return STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK;
  }
  return "Done.";
}

function sanitizeSpoken(
  spoken: string | undefined,
  runs: readonly SpokenTurnRun[],
  toolErrorMessage: string | undefined,
): string | undefined {
  if (spoken === undefined) {
    return undefined;
  }
  const trimmed = spoken.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!spokenContainsMarkdownDump(trimmed)) {
    return trimmed;
  }
  return spokenMarkdownDumpFallback(runs, toolErrorMessage);
}

/**
 * Resolve the visible reply from model text after presenter selection.
 * JSON objects (including a leftover `{ "spoken": ... }` envelope) are
 * invalid presentation: use the existing fallback and do not extract
 * `spoken`. HITL confirmation/choice still win over candidate prose
 * (unchanged until T6).
 */
export function spokenTurnText(options: {
  readonly rawText: string;
  readonly runs: readonly SpokenTurnRun[];
  /** Typed tool `message` when `outcome` is `error`. Model prose still wins. */
  readonly toolErrorMessage?: string;
}): string {
  if (turnHasHitlPause(options.runs)) {
    return STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT;
  }
  const trimmed = options.rawText.trim();
  if (trimmed !== "" && !looksLikeJsonObject(trimmed)) {
    return (
      sanitizeSpoken(trimmed, options.runs, options.toolErrorMessage) ??
      spokenFallbackFromRuns(options.runs, options.toolErrorMessage)
    );
  }
  return spokenFallbackFromRuns(options.runs, options.toolErrorMessage);
}

function isStaffAssistantTextStreamPartType(type: string): boolean {
  return type === "text-start" || type === "text-delta" || type === "text-end";
}

/**
 * Hold candidate reply text until the stream finalizes the selected
 * prose (SHO-507). Tool progress, result surfaces, and HITL parts pass
 * through immediately. Do not flatten JSON or extract `spoken`.
 */
export function createHoldCandidateReplyTextTransform<
  T extends SpokenStreamPart,
>(): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(part, controller) {
      if (isStaffAssistantTextStreamPartType(part.type)) {
        return;
      }
      controller.enqueue(part);
    },
  });
}
