import type {
  AssistantChatTracePart,
  AssistantInteraction,
} from "@showzy/validation/assistant-chat";

import type { StatusPillTone } from "../../../components/ui/status-pill";
import {
  assistantRecordHref,
  assistantWrittenRecordKind,
  type AssistantRecordKind,
} from "../shared/assistant-record-hrefs";
import type { AssistantThreadClosure } from "../thread/thread-rows";

export type AssistantClosedCardCopy = {
  readonly closed: {
    readonly done: string;
    readonly rejected: string;
    readonly failed: string;
    readonly open: string;
    readonly records: Readonly<Record<AssistantRecordKind, string>>;
  };
  readonly choiceTitle: string;
  readonly choiceChosen: string;
};

export type AssistantClosedCardOutcome =
  "done" | "rejected" | "failed" | "chosen";

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
  readonly question: string | null;
  readonly answer: string | null;
  readonly opens: readonly AssistantClosedCardOpen[];
};

const TONES: Readonly<Record<AssistantClosedCardOutcome, StatusPillTone>> = {
  done: "success",
  rejected: "neutral",
  failed: "danger",
  chosen: "neutral",
};

function closedOutcome(
  trace: AssistantChatTracePart,
): Exclude<AssistantClosedCardOutcome, "chosen"> | null {
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

function chosenCard(input: {
  readonly trace: AssistantChatTracePart;
  readonly question: AssistantInteraction | null;
  readonly copy: AssistantClosedCardCopy;
}): AssistantClosedCardModel | null {
  const { trace, question, copy } = input;
  if (
    trace.outcome !== "chosen" ||
    question === null ||
    question.kind !== "choice"
  ) {
    return null;
  }
  const picked = question.options.find(
    (option) => option.optionId === trace.optionId,
  );
  return {
    key: trace.interactionId,
    outcome: "chosen",
    label: copy.choiceChosen,
    tone: TONES.chosen,
    question: question.subject.length > 0 ? question.subject : copy.choiceTitle,
    answer: picked?.label ?? null,
    opens: NO_OPENS,
  };
}

const NO_OPENS: readonly AssistantClosedCardOpen[] = [];

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
  readonly question: AssistantInteraction | null;
  readonly copy: AssistantClosedCardCopy;
}): AssistantClosedCardModel | null {
  const { trace } = input;
  const { closed } = input.copy;
  if (trace.interactionKind === "choice") {
    return chosenCard(input);
  }
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
    question: null,
    answer: null,
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

export function assistantClosedCardModels(input: {
  readonly closures: readonly AssistantThreadClosure[];
  readonly copy: AssistantClosedCardCopy;
}): readonly AssistantClosedCardModel[] {
  const models: AssistantClosedCardModel[] = [];
  for (const closure of input.closures) {
    const model = assistantClosedCardModel({ ...closure, copy: input.copy });
    if (model !== null) {
      models.push(model);
    }
  }
  return models;
}
