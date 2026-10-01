import type { AssistantChoiceOption } from "@showzy/validation/assistant-chat";

export const ASSISTANT_CHOICE_CREATE_MARK = "+";

export type AssistantChoiceCardCopy = {
  readonly choiceTitle: string;
  readonly choiceNearest: string;
  readonly choiceCompose: string;
  readonly choiceChosen: string;
  readonly choiceTruncated: string;
  readonly dismissLabel: string;
};

export type AssistantChoiceRow = {
  readonly optionId: string;
  readonly mark: string;
  readonly label: string;
  readonly detail: string | null;
  readonly create: boolean;
  readonly chosen: boolean;
  readonly tappable: boolean;
};

export type AssistantChoiceCardModel = {
  readonly eyebrow: string | null;
  readonly title: string;
  readonly problem: string | null;
  readonly rows: readonly AssistantChoiceRow[];
  readonly footnotes: readonly string[];
  readonly composeLabel: string | null;
  readonly dismissLabel: string | null;
  readonly chosenLabel: string;
};

export function assistantChoiceCardModel(input: {
  readonly subject: string;
  readonly options: readonly AssistantChoiceOption[];
  readonly optionsTruncated: boolean;
  readonly nearest: boolean;
  readonly problem: string | undefined;
  readonly applying: boolean;
  readonly answeredOptionId: string | null;
  readonly copy: AssistantChoiceCardCopy;
}): AssistantChoiceCardModel {
  const { copy } = input;
  const open = !input.applying;
  let recordCount = 0;
  const rows = input.options.map((option): AssistantChoiceRow => {
    const create = option.kind === "create";
    if (!create) {
      recordCount += 1;
    }
    return {
      optionId: option.optionId,
      mark: create ? ASSISTANT_CHOICE_CREATE_MARK : String(recordCount),
      label: option.label,
      detail: option.detail ?? null,
      create,
      chosen: !open && option.optionId === input.answeredOptionId,
      tappable: open,
    };
  });

  return {
    eyebrow: input.nearest ? copy.choiceNearest : null,
    title: input.subject.length > 0 ? input.subject : copy.choiceTitle,
    problem: input.problem ?? null,
    rows,
    footnotes: input.optionsTruncated ? [copy.choiceTruncated] : [],
    composeLabel: open ? copy.choiceCompose : null,
    dismissLabel: open ? copy.dismissLabel : null,
    chosenLabel: copy.choiceChosen,
  };
}
