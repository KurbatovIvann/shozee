import type { AssistantChatTracePart } from "@showzy/validation/assistant-chat";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import {
  assistantRecordHref,
  assistantWrittenRecordKind,
  type AssistantRecordKind,
} from "../shared/assistant-record-hrefs";

export type AssistantClosedCardCopy = {
  readonly closed: {
    readonly done: string;
    readonly rejected: string;
    readonly failed: string;
    readonly open: string;
    readonly records: Readonly<Record<AssistantRecordKind, string>>;
  };
};

export type AssistantClosedCardOutcome = "done" | "rejected" | "failed";

export type AssistantClosedCardOpen = {
  readonly key: string;
  readonly label: string;
  readonly href: string;
};

export type AssistantClosedCardModel = {
  readonly key: string;
  readonly outcome: AssistantClosedCardOutcome;
  readonly label: string;
  readonly tone: StatusPillTone;
  readonly opens: readonly AssistantClosedCardOpen[];
};

const TONES: Readonly<Record<AssistantClosedCardOutcome, StatusPillTone>> = {
  done: "success",
  rejected: "neutral",
  failed: "danger",
};

function closedOutcome(
  trace: AssistantChatTracePart,
): AssistantClosedCardOutcome | null {
  switch (trace.outcome) {
    case "done":
    case "rejected":
    case "failed":
      return trace.outcome;
    case "chosen":
    case "superseded":
      return null;
  }
}

type OpenTarget = {
  readonly key: string;
  readonly kind: AssistantRecordKind;
  readonly href: string;
};

function openTargets(trace: AssistantChatTracePart): readonly OpenTarget[] {
  const targets: OpenTarget[] = [];
  for (const [index, attempt] of trace.attempts.entries()) {
    const recordId = attempt.recordId;
    if (recordId === null || attempt.outcome !== "done") {
      continue;
    }
    const kind = assistantWrittenRecordKind(attempt.action);
    if (kind === null) {
      continue;
    }
    targets.push({
      key: `${trace.interactionId}:${String(index)}`,
      kind,
      href: assistantRecordHref(kind, recordId),
    });
  }
  return targets;
}

export function assistantClosedCardModel(input: {
  readonly trace: AssistantChatTracePart;
  readonly copy: AssistantClosedCardCopy;
}): AssistantClosedCardModel | null {
  const { trace } = input;
  const { closed } = input.copy;
  if (trace.interactionKind !== "confirmation") {
    return null;
  }
  const outcome = closedOutcome(trace);
  if (outcome === null) {
    return null;
  }
  const targets = openTargets(trace);
  return {
    key: trace.interactionId,
    outcome,
    label: closed[outcome],
    tone: TONES[outcome],
    opens: targets.map((target) => ({
      key: target.key,
      label:
        targets.length === 1
          ? closed.open
          : `${closed.open}: ${closed.records[target.kind]}`,
      href: target.href,
    })),
  };
}

export function assistantClosedCardModels(
  traces: readonly AssistantChatTracePart[],
  copy: AssistantClosedCardCopy,
): readonly AssistantClosedCardModel[] {
  const models: AssistantClosedCardModel[] = [];
  for (const trace of traces) {
    const model = assistantClosedCardModel({ trace, copy });
    if (model !== null) {
      models.push(model);
    }
  }
  return models;
}
