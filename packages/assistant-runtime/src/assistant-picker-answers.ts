import { answerPickerFromMessage, type JudgmentProvider } from "@showzy/ai";

import type { AssistantPickerAnswer } from "./assistant-kit-tools.js";

export interface AssistantPickerAnswersTurn {
  readonly answer: AssistantPickerAnswer;
  answered(): number;
}

export interface AssistantPickerAnswers {
  forTurn(args: {
    readonly message: string;
    readonly signal: AbortSignal;
  }): AssistantPickerAnswersTurn;
}

export function createAssistantPickerAnswers(deps: {
  readonly provider: JudgmentProvider;
}): AssistantPickerAnswers {
  return {
    forTurn({ message, signal }) {
      let answered = 0;
      return {
        async answer(picker, line) {
          const chosen = await answerPickerFromMessage({
            provider: deps.provider,
            message,
            picker,
            signal,
            ...(line === undefined ? {} : { line }),
          }).catch(() => undefined);
          if (chosen !== undefined) {
            answered += 1;
          }
          return chosen;
        },
        answered: () => answered,
      };
    },
  };
}
