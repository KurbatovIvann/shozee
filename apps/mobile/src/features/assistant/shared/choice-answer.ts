export type AssistantChoiceAnswer = {
  readonly optionId: string;
};

export function assistantChoiceAnswer(optionId: string): AssistantChoiceAnswer {
  return { optionId };
}

export function assistantChoiceAnswerOptionId(answer: unknown): string | null {
  if (
    typeof answer !== "object" ||
    answer === null ||
    !("optionId" in answer)
  ) {
    return null;
  }
  const { optionId } = answer;
  return typeof optionId === "string" ? optionId : null;
}
