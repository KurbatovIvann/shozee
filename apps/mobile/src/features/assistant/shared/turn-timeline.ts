/**
 * Live-turn tool timeline from current `UIMessage` parts (SHO-368).
 * Parse part names only — no list/aggregate cards, no persistence.
 */
import { choiceFromChatPart } from "./choice";
import { confirmationFromChatPart } from "./confirmation";
import {
  isToolErrorOutput,
  type AssistantChatPart,
} from "./confirmation-presenter";

export type AssistantTimelineStatus = "queued" | "running" | "done" | "error";

export type AssistantToolStep = {
  readonly id: string;
  readonly toolName: string;
  readonly status: AssistantTimelineStatus;
};

const TOOL_TYPE_PREFIX = "tool-";
const DYNAMIC_TOOL_TYPE = "dynamic-tool";
const EMPTY_CHALLENGE_IDS: ReadonlySet<string> = new Set();

export function toolNameFromPart(part: AssistantChatPart): string | null {
  if (part.type === DYNAMIC_TOOL_TYPE) {
    return typeof part.toolName === "string" && part.toolName.length > 0
      ? part.toolName
      : null;
  }
  if (
    part.type.startsWith(TOOL_TYPE_PREFIX) &&
    part.type.length > TOOL_TYPE_PREFIX.length
  ) {
    return part.type.slice(TOOL_TYPE_PREFIX.length);
  }
  return null;
}

export function timelineStatusFromPartState(
  state: string | undefined,
  output?: unknown,
): AssistantTimelineStatus {
  switch (state) {
    case "output-available":
      // HITL pause finishes the AI SDK tool part as output-available with
      // a confirmation_required payload. That is still in-flight.
      if (confirmationFromChatPart(output) !== undefined) {
        return "running";
      }
      if (choiceFromChatPart(output) !== undefined) {
        return "running";
      }
      // HTTP 200 façade failures also arrive as output-available.
      return isToolErrorOutput(output) ? "error" : "done";
    case "output-error":
    case "output-denied":
      return "error";
    case "input-streaming":
      return "queued";
    default:
      return "running";
  }
}

function dismissedConfirmationToolCallIds(
  parts: readonly AssistantChatPart[],
  dismissedChallengeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (dismissedChallengeIds.size === 0) {
    return ids;
  }
  for (const part of parts) {
    const fromPart = confirmationFromChatPart(part);
    if (
      fromPart !== undefined &&
      dismissedChallengeIds.has(fromPart.challengeId)
    ) {
      ids.add(fromPart.toolCallId);
    }
    const fromOutput = confirmationFromChatPart(part.output);
    if (
      fromOutput !== undefined &&
      dismissedChallengeIds.has(fromOutput.challengeId)
    ) {
      ids.add(fromOutput.toolCallId);
    }
    const fromChoicePart = choiceFromChatPart(part);
    if (
      fromChoicePart !== undefined &&
      dismissedChallengeIds.has(fromChoicePart.challengeId) &&
      typeof part.toolCallId === "string"
    ) {
      ids.add(part.toolCallId);
    }
    const fromChoiceOutput = choiceFromChatPart(part.output);
    if (
      fromChoiceOutput !== undefined &&
      dismissedChallengeIds.has(fromChoiceOutput.challengeId) &&
      typeof part.toolCallId === "string"
    ) {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function omitDismissedToolPart(
  part: AssistantChatPart,
  dismissedChallengeIds: ReadonlySet<string>,
  dismissedToolCallIds: ReadonlySet<string>,
): boolean {
  const paused = confirmationFromChatPart(part.output);
  if (paused !== undefined && dismissedChallengeIds.has(paused.challengeId)) {
    return true;
  }
  const pausedChoice = choiceFromChatPart(part.output);
  if (
    pausedChoice !== undefined &&
    dismissedChallengeIds.has(pausedChoice.challengeId)
  ) {
    return true;
  }
  if (part.state === "output-available" && paused === undefined) {
    return false;
  }
  const callId = part.toolCallId;
  return (
    typeof callId === "string" &&
    callId.length > 0 &&
    dismissedToolCallIds.has(callId)
  );
}

/**
 * Ordered live-turn tool steps. Skips text, `data-confirmation`,
 * `data-choice`, `data-presentation`, Anthropic synthetic `json`
 * structured-output tools, and dismissed/ignored HITL tools. Does not
 * stringify `output`.
 * dismissed/ignored HITL tools. Does not stringify `output`.
 */
export function toolStepsFromParts(
  parts: readonly AssistantChatPart[],
  messageId: string,
  dismissedChallengeIds: ReadonlySet<string> = EMPTY_CHALLENGE_IDS,
): readonly AssistantToolStep[] {
  const dismissedToolCallIds = dismissedConfirmationToolCallIds(
    parts,
    dismissedChallengeIds,
  );
  const steps: AssistantToolStep[] = [];
  for (const [index, part] of parts.entries()) {
    const toolName = toolNameFromPart(part);
    if (toolName === null) {
      continue;
    }
    if (toolName === "json") {
      continue;
    }
    if (
      omitDismissedToolPart(part, dismissedChallengeIds, dismissedToolCallIds)
    ) {
      continue;
    }
    const callId = part.toolCallId;
    steps.push({
      id:
        typeof callId === "string" && callId.length > 0
          ? callId
          : `${messageId}:${String(index)}`,
      toolName,
      status: timelineStatusFromPartState(part.state, part.output),
    });
  }
  return steps;
}
