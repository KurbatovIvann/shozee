/**
 * Host turn speech (ADR-0037 / SHO-520).
 *
 * Usable model prose is the bubble. Guardrail rejects leftover `{…}` JSON
 * only — not emphasis `**`, and not markdown tables. Do not call
 * `commitTurnSpeech`. Do not use create-success or domain-error copy as
 * the winner. `source` is in-memory, not a database column.
 */
import { staffAssistantLocale, type StaffAssistantLocale } from "../locale.js";
import {
  STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK,
  STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
  type CommittedSpeech,
  type StaffAssistantTurnRun,
} from "../turn-speech.js";

export type { CommittedSpeech };

/**
 * Leftover `{ "spoken" }` (or any leftover JSON object). Do not extract
 * `spoken`. Markdown tables and `**` are usable prose.
 */
export function looksLikeLeftoverJsonObject(text: string): boolean {
  return text.trimStart().startsWith("{");
}

export function usableHostModelText(rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (looksLikeLeftoverJsonObject(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Last usable step text. Concatenated `result.text` can start with leftover
 * `{…}` JSON from an earlier tool step and would discard later narration.
 */
export function lastUsableHostModelText(
  stepTexts: readonly string[],
): string | undefined {
  let last: string | undefined;
  for (const text of stepTexts) {
    const usable = usableHostModelText(text);
    if (usable !== undefined) {
      last = usable;
    }
  }
  return last;
}

function speechFallbackFromRuns(
  runs: readonly StaffAssistantTurnRun[],
  locale: StaffAssistantLocale,
): string {
  if (runs.some((run) => run.outcome === "error")) {
    return STAFF_ASSISTANT_TOOL_ERROR_FALLBACK[locale];
  }
  if (
    runs.some(
      (run) =>
        run.outcome === "success" ||
        run.outcome === "confirmation_required" ||
        run.outcome === "choice_required",
    )
  ) {
    return STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK[locale];
  }
  return STAFF_ASSISTANT_EMPTY_SPEECH_FALLBACK[locale];
}

/**
 * Commit the visible/persisted line for the new host.
 * Priority: usable model prose; else one locale-keyed generic fallback.
 * `toolOutputs` is accepted so callers can pass presented results; typed
 * domain-error copy is not the bubble (ADR-0037 §4).
 */
export function commitHostSpeech(options: {
  readonly locale: string | undefined;
  readonly rawText: string;
  readonly runs: readonly StaffAssistantTurnRun[];
  readonly toolOutputs?: readonly unknown[];
}): CommittedSpeech {
  const locale = staffAssistantLocale(
    typeof options.locale === "string" ? options.locale : undefined,
  );
  const usable = usableHostModelText(options.rawText);
  if (usable !== undefined) {
    return { source: "model", text: usable };
  }
  return {
    source: "fallback",
    text: speechFallbackFromRuns(options.runs, locale),
  };
}
