/**
 * Spoken reply envelope for the staff assistant (SHO-386 / SHO-383 T3).
 *
 * `Output.object` here is a **reply envelope only** — `{ spoken }` — not
 * card protocol. Cards stay a projection of tool parts (ADR-0011). Surface
 * `promptLine`s live in `@showzy/validation/assistant-surfaces`; this file
 * does not copy them.
 */
import { z } from "zod";

import { STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT } from "./confirmation.js";

/** Anthropic json-tool / structured-output synthetic name. Not a domain action. */
export const STAFF_ASSISTANT_SYNTHETIC_JSON_TOOL_NAME = "json";

/**
 * Short product-language line when spoken is empty or a markdown dump
 * after a successful tool turn. Never "Done." for a successful list.
 */
export const STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK =
  "Here is a short summary of the result.";

/**
 * Persist/stream fallback when a tool run failed and the model produced
 * no `{ spoken }`. Never `"Done."` after a tool error (SHO-429).
 */
export const STAFF_ASSISTANT_TOOL_ERROR_FALLBACK =
  "The assistant could not complete this turn.";

/** `{ spoken }` only — no rows, cards, kinds, money, or order payloads. */
export const staffAssistantSpokenOutputSchema = z.strictObject({
  spoken: z.string(),
});

export type StaffAssistantSpokenOutput = z.output<
  typeof staffAssistantSpokenOutputSchema
>;

type SpokenTurnRun = {
  readonly outcome:
    "success" | "error" | "confirmation_required" | "choice_required";
};

type SpokenStreamPart = {
  readonly type: string;
  readonly id?: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStaffAssistantSyntheticJsonTool(name: string): boolean {
  return name === STAFF_ASSISTANT_SYNTHETIC_JSON_TOOL_NAME;
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

/**
 * Parse a complete `{ "spoken": "..." }` model text. Undefined when the
 * model wrote prose (fail-open) or HITL skipped the JSON step.
 */
export function spokenFromModelText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed["spoken"] === "string") {
      return parsed["spoken"];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Best-effort `spoken` prefix from complete or partial JSON so the UI
 * stream can emit prose instead of `{"spoken":…}`.
 */
export function spokenPrefixFromPartialJson(text: string): string | undefined {
  const complete = spokenFromModelText(text);
  if (complete !== undefined) {
    return complete;
  }
  const key = '"spoken"';
  const keyIndex = text.indexOf(key);
  if (keyIndex < 0) {
    return undefined;
  }
  const afterKey = text.slice(keyIndex + key.length);
  const colon = afterKey.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const rest = afterKey.slice(colon + 1).trimStart();
  if (!rest.startsWith('"')) {
    return undefined;
  }
  let spoken = "";
  for (let index = 1; index < rest.length; index += 1) {
    const char = rest[index];
    if (char === undefined) {
      break;
    }
    if (char === "\\") {
      const next = rest[index + 1];
      if (next === undefined) {
        break;
      }
      spoken += unescapeJsonChar(next);
      index += 1;
      continue;
    }
    if (char === '"') {
      break;
    }
    spoken += char;
  }
  return spoken;
}

function unescapeJsonChar(escaped: string): string {
  switch (escaped) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    default:
      return escaped;
  }
}

function looksLikeJsonObject(text: string): boolean {
  return text.trimStart().startsWith("{");
}

export function spokenTurnText(options: {
  readonly parsedSpoken: string | undefined;
  readonly rawText: string;
  readonly runs: readonly SpokenTurnRun[];
  /** Typed tool `message` when `outcome` is `error`. Model `{ spoken }` still wins. */
  readonly toolErrorMessage?: string;
}): string {
  const fromParsed = sanitizeSpoken(
    options.parsedSpoken,
    options.runs,
    options.toolErrorMessage,
  );
  if (fromParsed !== undefined) {
    return fromParsed;
  }
  const fromRaw = sanitizeSpoken(
    spokenFromModelText(options.rawText),
    options.runs,
    options.toolErrorMessage,
  );
  if (fromRaw !== undefined) {
    return fromRaw;
  }
  const trimmed = options.rawText.trim();
  if (trimmed !== "" && !looksLikeJsonObject(trimmed)) {
    // Output.object parse failure can leave a markdown table as plain text.
    return (
      sanitizeSpoken(trimmed, options.runs, options.toolErrorMessage) ?? trimmed
    );
  }
  if (
    options.runs.some(
      (run) =>
        run.outcome === "confirmation_required" ||
        run.outcome === "choice_required",
    )
  ) {
    return STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT;
  }
  if (options.runs.some((run) => run.outcome === "error")) {
    return typedToolErrorSpokenFallback(options.toolErrorMessage);
  }
  if (options.runs.some((run) => run.outcome === "success")) {
    return STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK;
  }
  return "Done.";
}

/**
 * Markdown `{ spoken }` fail-open. HITL on the same turn must win over a
 * prior successful tool (do not show a short success summary while a
 * confirmation card is active). Never `"Done."` here.
 */
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
  if (
    runs.some(
      (run) =>
        run.outcome === "confirmation_required" ||
        run.outcome === "choice_required",
    )
  ) {
    return STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT;
  }
  if (runs.some((run) => run.outcome === "error")) {
    return typedToolErrorSpokenFallback(toolErrorMessage);
  }
  return STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK;
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

function syntheticJsonNameFromPart(part: SpokenStreamPart): string | null {
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    return part.toolName;
  }
  const prefix = "tool-";
  if (part.type.startsWith(prefix) && part.type.length > prefix.length) {
    return part.type.slice(prefix.length);
  }
  return null;
}

/**
 * Flatten `{ spoken }` JSON text-deltas to prose and drop Anthropic
 * synthetic `json` tool parts so `useChat` never shows raw envelope JSON.
 */
export function createSpokenReplyUiTransform<
  T extends SpokenStreamPart,
>(options?: {
  readonly runs?: readonly SpokenTurnRun[];
  readonly toolErrorMessage?: () => string | undefined;
}): TransformStream<T, T> {
  let accumulatedJson = "";
  let publishedSpoken = "";
  let heldMarkdownTextEnd: T | undefined;
  const droppedCallIds = new Set<string>();

  const emitHeldMarkdownFailOpen = (
    controller: TransformStreamDefaultController<T>,
  ) => {
    if (heldMarkdownTextEnd === undefined) {
      return;
    }
    const held = heldMarkdownTextEnd;
    heldMarkdownTextEnd = undefined;
    controller.enqueue({
      ...held,
      type: "text-delta",
      text: spokenMarkdownDumpFallback(
        options?.runs ?? [],
        options?.toolErrorMessage?.(),
      ),
    });
    controller.enqueue(held);
  };

  return new TransformStream<T, T>({
    transform(part, controller) {
      const syntheticName = syntheticJsonNameFromPart(part);
      if (
        syntheticName !== null &&
        isStaffAssistantSyntheticJsonTool(syntheticName)
      ) {
        if (typeof part.id === "string" && part.id.length > 0) {
          droppedCallIds.add(part.id);
        }
        if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
          droppedCallIds.add(part.toolCallId);
        }
        return;
      }
      const callId = part.toolCallId ?? part.id;
      if (
        typeof callId === "string" &&
        callId.length > 0 &&
        droppedCallIds.has(callId) &&
        part.type !== "text-delta" &&
        part.type !== "text-start" &&
        part.type !== "text-end"
      ) {
        return;
      }

      if (part.type === "text-start") {
        emitHeldMarkdownFailOpen(controller);
        accumulatedJson = "";
        publishedSpoken = "";
        controller.enqueue(part);
        return;
      }

      if (part.type === "text-delta") {
        const delta = typeof part.text === "string" ? part.text : "";
        accumulatedJson += delta;
        const spoken = spokenPrefixFromPartialJson(accumulatedJson);
        if (spoken === undefined || spokenContainsMarkdownDump(spoken)) {
          return;
        }
        if (!spoken.startsWith(publishedSpoken)) {
          publishedSpoken = spoken;
          controller.enqueue({ ...part, text: spoken });
          return;
        }
        const next = spoken.slice(publishedSpoken.length);
        publishedSpoken = spoken;
        if (next.length === 0) {
          return;
        }
        controller.enqueue({ ...part, text: next });
        return;
      }

      if (part.type === "text-end") {
        if (publishedSpoken === "" && accumulatedJson.trim() !== "") {
          if (!looksLikeJsonObject(accumulatedJson)) {
            if (spokenContainsMarkdownDump(accumulatedJson)) {
              // Same delay as JSON `{ spoken }` dumps so HITL can still win.
              heldMarkdownTextEnd = part;
              return;
            }
            controller.enqueue({
              ...part,
              type: "text-delta",
              text: accumulatedJson,
            });
          } else {
            const parsed = spokenFromModelText(accumulatedJson);
            if (parsed !== undefined && spokenContainsMarkdownDump(parsed)) {
              // Delay until flush so a later same-step confirmation_required
              // tool result can win over the successful-list markdown fail-open.
              heldMarkdownTextEnd = part;
              return;
            }
          }
        }
        controller.enqueue(part);
        return;
      }

      controller.enqueue(part);
    },
    flush(controller) {
      emitHeldMarkdownFailOpen(controller);
    },
  });
}
