import type { ModelMessage } from "@showzy/assistant-kit";
import { foldNameWords } from "@showzy/module-kit/name-match";
import type { ShoCommand } from "@showzy/sho-protocol";
import {
  assistantInteractionFromPause,
  type AssistantChoiceOption,
  type AssistantPause,
} from "@showzy/validation/assistant-chat";
import { z } from "zod";

import {
  assistantAffirmedAnswer,
  matchAssistantChoiceText,
  type AssistantPauseMatch,
} from "./assistant-pause-match.js";
import { shoFocusFrom, shoOpenCardPrevious } from "./sho-focus.js";
import type { ShoEngine } from "./sho-turn.js";

export const SHO_UI_PICK = "ui.pick";
export const SHO_UI_CONFIRM = "ui.confirm";

export const SHO_CARD_ANSWER_ACTIONS: readonly string[] = [
  SHO_UI_PICK,
  SHO_UI_CONFIRM,
];

export const SHO_CARD_ANSWER_WORDS = 3;

export const SHO_PICK_TEXT_PARAM = "pick_text";

const saidParamSchema = z.object({ text: z.string().min(1) });

export function shoMayReadCard(read: AssistantPauseMatch): boolean {
  return read.kind === "supersede";
}

export function shoIsBareCardAnswer(text: string): boolean {
  return foldNameWords(text).length <= SHO_CARD_ANSWER_WORDS;
}

function wholeUtterance(command: ShoCommand): boolean {
  return !command.needs.some(
    (need) => need.blocking || need.reason === "ignored",
  );
}

function answersTheCard(command: ShoCommand): boolean {
  return (
    SHO_CARD_ANSWER_ACTIONS.includes(command.action) && wholeUtterance(command)
  );
}

function saidOptions(command: ShoCommand): readonly string[] {
  const picked = saidParamSchema.safeParse(command.params[SHO_PICK_TEXT_PARAM]);
  return picked.success && picked.data.text !== command.text
    ? [command.text, picked.data.text]
    : [command.text];
}

function choiceAnswer(
  options: readonly AssistantChoiceOption[],
  said: readonly string[],
): AssistantPauseMatch | null {
  let hinted: AssistantPauseMatch | null = null;
  for (const text of said) {
    const picked = matchAssistantChoiceText(options, text);
    if (picked.kind === "answer") {
      return picked;
    }
    if (picked.kind === "hint" && hinted === null) {
      hinted = picked;
    }
  }
  return hinted;
}

export function shoCardAnswerFor(
  command: ShoCommand,
  pause: AssistantPause,
): AssistantPauseMatch | null {
  if (!answersTheCard(command)) {
    return null;
  }
  const interaction = assistantInteractionFromPause(pause);
  if (interaction === null) {
    return null;
  }
  if (command.action === SHO_UI_CONFIRM) {
    return assistantAffirmedAnswer(interaction);
  }
  if (interaction.kind === "confirmation") {
    return null;
  }
  return choiceAnswer(interaction.options, saidOptions(command));
}

export interface ShoCardAnswerInput {
  readonly text: string;
  readonly sessionId: string;
  readonly now: Date;
  readonly history: readonly ModelMessage[];
  readonly pause: AssistantPause;
  readonly engine: ShoEngine;
}

export async function runShoCardAnswer(
  input: ShoCardAnswerInput,
): Promise<AssistantPauseMatch | null> {
  if (!shoIsBareCardAnswer(input.text)) {
    return null;
  }
  const previous = shoOpenCardPrevious(input.history);
  const plan = await input.engine.plan({
    text: input.text,
    now: input.now,
    focus: shoFocusFrom(input.history, input.sessionId),
    ...(previous === undefined ? {} : { previous }),
  });
  const command = plan.command;
  return command === undefined ? null : shoCardAnswerFor(command, input.pause);
}
