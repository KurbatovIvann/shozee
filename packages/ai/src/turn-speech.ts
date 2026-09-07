/**
 * Tagged turn speech (ADR-0036 / SHO-518).
 *
 * One writer for live `text-*` and `assistant_messages.body`. Surfaces
 * stay cards; this module never serializes collection rows. `source` is
 * in-memory for tests and logs, not a database column.
 */
import { presentChoiceStaffAssistantTurn } from "./choice.js";
import { STAFF_ASSISTANT_CONFIRMATION_COPY } from "./confirmation.js";
import { presentDomainErrorStaffAssistantTurn } from "./domain-error.js";
import { staffAssistantLocale, type StaffAssistantLocale } from "./locale.js";

export type SpeechSource = "model" | "protocol" | "fallback";

export type CommittedSpeech = {
  readonly source: SpeechSource;
  readonly text: string;
};

export type StaffAssistantPresentedToolResult = {
  readonly toolName: string;
  readonly output: unknown;
  readonly toolCallId?: string;
};

export type StaffAssistantTurnRun = {
  readonly outcome:
    "success" | "error" | "confirmation_required" | "choice_required";
};

/**
 * Short product-language line when model text is empty or unusable
 * after a successful tool turn. Never "Done." for a successful list.
 */
export const STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK: Record<
  StaffAssistantLocale,
  string
> = {
  uk: "Коротко про результат.",
  en: "Here is a short summary of the result.",
};

/**
 * Persist/stream fallback when a tool run failed and the model produced
 * no usable reply. Never `"Done."` after a tool error (SHO-429).
 */
export const STAFF_ASSISTANT_TOOL_ERROR_FALLBACK: Record<
  StaffAssistantLocale,
  string
> = {
  uk: "Не вдалося завершити цей хід.",
  en: "The assistant could not complete this turn.",
};

/** Last-resort line when there is no model text and no successful run. */
export const STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK: Record<
  StaffAssistantLocale,
  string
> = {
  uk: "Готово.",
  en: "Done.",
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

function staffAssistantModelTextContainsMarkdownDump(text: string): boolean {
  return text.includes("|") || text.includes("**") || text.includes("```");
}

function looksLikeJsonObject(text: string): boolean {
  return text.trimStart().startsWith("{");
}

/**
 * Candidate model prose after buffering, before commit. Empty, leftover
 * `{ "spoken" }` JSON, and markdown dumps are not usable. Do not extract
 * `spoken` from the object.
 */
export function usableStaffAssistantModelText(
  rawText: string,
): string | undefined {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (
    looksLikeJsonObject(trimmed) ||
    staffAssistantModelTextContainsMarkdownDump(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function turnHasHitlPause(runs: readonly StaffAssistantTurnRun[]): boolean {
  return runs.some(
    (run) =>
      run.outcome === "confirmation_required" ||
      run.outcome === "choice_required",
  );
}

function typedToolErrorSpeechFallback(
  toolErrorMessage: string | undefined,
  locale: StaffAssistantLocale,
): string {
  const fallback = toolErrorMessage?.trim();
  if (fallback !== undefined && fallback !== "") {
    return fallback;
  }
  return STAFF_ASSISTANT_TOOL_ERROR_FALLBACK[locale];
}

function speechFallbackFromRuns(
  runs: readonly StaffAssistantTurnRun[],
  toolErrorMessage: string | undefined,
  locale: StaffAssistantLocale,
): string {
  if (runs.some((run) => run.outcome === "error")) {
    return typedToolErrorSpeechFallback(toolErrorMessage, locale);
  }
  if (runs.some((run) => run.outcome === "success")) {
    return STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK[locale];
  }
  return STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK[locale];
}

/**
 * Commit the visible/persisted line for a staff-assistant turn.
 * Priority: HITL / typed domain-error protocol copy; else usable model
 * prose; else one locale-keyed generic fallback. Never a card dump.
 */
export function commitTurnSpeech(options: {
  readonly locale: string | undefined;
  readonly toolResults: readonly StaffAssistantPresentedToolResult[];
  readonly rawText: string;
  readonly runs: readonly StaffAssistantTurnRun[];
  /** Modelless HITL resume protocol line (confirmation expired). */
  readonly protocolOverride?: string;
}): CommittedSpeech {
  const locale = staffAssistantLocale(
    typeof options.locale === "string" ? options.locale : undefined,
  );
  const protocolOverride = options.protocolOverride?.trim();
  if (protocolOverride !== undefined && protocolOverride !== "") {
    return { source: "protocol", text: protocolOverride };
  }
  const choice = presentChoiceStaffAssistantTurn({
    locale,
    toolResults: options.toolResults,
  });
  if (choice !== undefined) {
    return { source: "protocol", text: choice };
  }
  if (turnHasHitlPause(options.runs)) {
    return {
      source: "protocol",
      text: STAFF_ASSISTANT_CONFIRMATION_COPY[locale],
    };
  }
  const domainError = presentDomainErrorStaffAssistantTurn({
    locale,
    toolResults: options.toolResults,
  });
  if (domainError !== undefined) {
    return { source: "protocol", text: domainError };
  }
  const usable = usableStaffAssistantModelText(options.rawText);
  if (usable !== undefined) {
    return { source: "model", text: usable };
  }
  const toolErrorMessage = lastStaffAssistantTypedToolErrorMessage(
    options.toolResults.map((result) => result.output),
  );
  return {
    source: "fallback",
    text: speechFallbackFromRuns(options.runs, toolErrorMessage, locale),
  };
}
