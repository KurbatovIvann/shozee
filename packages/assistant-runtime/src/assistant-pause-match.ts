import {
  exactNameText,
  foldNameWords,
  matchNameTiers,
} from "@showzy/module-kit/name-match";
import {
  assistantInteractionFromPause,
  type AssistantChoiceOption,
  type AssistantInteraction,
  type AssistantPause,
} from "@showzy/validation/assistant-chat";

export type AssistantPauseMatch =
  | { readonly kind: "answer"; readonly answer: unknown }
  | { readonly kind: "decline" }
  | { readonly kind: "hint"; readonly hint: string }
  | { readonly kind: "supersede" };

const AFFIRMATIVE = new Set([
  "так",
  "ага",
  "угу",
  "ок",
  "окей",
  "гаразд",
  "добре",
  "давай",
  "давайте",
  "підтверджую",
  "підтверджуй",
  "підтвердити",
  "погоджуюсь",
  "згоден",
  "згодна",
  "yes",
  "y",
  "ok",
  "okay",
]);

const NEGATIVE = new Set([
  "ні",
  "нє",
  "неа",
  "не",
  "скасуй",
  "скасуйте",
  "скасувати",
  "відміна",
  "відміни",
  "відмінити",
  "стоп",
  "no",
  "n",
  "nope",
  "cancel",
  "stop",
]);

const ORDINAL_STEMS = [
  "перш",
  "друг",
  "трет",
  "четверт",
  "п'ят",
  "шост",
  "сьом",
  "восьм",
  "дев'ят",
  "десят",
] as const;

const DIGITS_ONLY = /^\d+$/u;

const HINT_OPTIONS_MAX = 5;
const HINT_LABEL_MAX = 80;

const STRONG_HINT = "Це дія з наслідками — підтвердьте її кнопкою на картці.";
const CHOICE_CONTROL_HINT =
  "Оберіть один із варіантів: вкажіть його номер або назву.";

type ControlWord = "affirmative" | "negative" | null;

function controlWord(spoken: readonly string[]): ControlWord {
  if (spoken.length === 0) {
    return null;
  }
  if (spoken.every((word) => AFFIRMATIVE.has(word))) {
    return "affirmative";
  }
  return spoken.every((word) => NEGATIVE.has(word)) ? "negative" : null;
}

function spokenPosition(spoken: readonly string[]): number | null {
  if (spoken.length !== 1) {
    return null;
  }
  const word = spoken[0];
  if (word === undefined) {
    return null;
  }
  if (DIGITS_ONLY.test(word)) {
    return Number.parseInt(word, 10);
  }
  const ordinal = ORDINAL_STEMS.findIndex((stem) => word.startsWith(stem));
  return ordinal === -1 ? null : ordinal + 1;
}

function clipLabel(label: string): string {
  return label.length > HINT_LABEL_MAX
    ? `${label.slice(0, HINT_LABEL_MAX)}…`
    : label;
}

function ambiguousHint(labels: readonly string[]): string {
  const shown = labels
    .slice(0, HINT_OPTIONS_MAX)
    .map((label) => `«${clipLabel(label)}»`)
    .join(", ");
  return `Підходить кілька варіантів: ${shown}. Вкажіть номер або оберіть на картці.`;
}

function outOfRangeHint(count: number): string {
  return `На картці варіанти з 1 до ${String(count)}. Вкажіть номер із цього переліку або назву.`;
}

function pickedOption(option: AssistantChoiceOption): AssistantPauseMatch {
  return { kind: "answer", answer: { optionId: option.optionId } };
}

function matchChoice(
  options: readonly AssistantChoiceOption[],
  text: string,
  spoken: readonly string[],
): AssistantPauseMatch {
  const position = spokenPosition(spoken);
  if (position !== null) {
    const numbered = options[position - 1];
    return numbered === undefined
      ? { kind: "hint", hint: outOfRangeHint(options.length) }
      : pickedOption(numbered);
  }
  const labels = options.map((option) => option.label);
  const exact = labels.flatMap((label, index) =>
    exactNameText(label, text) ? [index] : [],
  );
  const hits = exact.length > 0 ? exact : matchNameTiers(text, labels);
  const first = hits[0];
  if (hits.length === 1 && first !== undefined) {
    const only = options[first];
    return only === undefined ? { kind: "supersede" } : pickedOption(only);
  }
  return hits.length > 1
    ? {
        kind: "hint",
        hint: ambiguousHint(
          hits.flatMap((index) => {
            const label = labels[index];
            return label === undefined ? [] : [label];
          }),
        ),
      }
    : { kind: "supersede" };
}

export function assistantAffirmedAnswer(
  interaction: AssistantInteraction,
): AssistantPauseMatch {
  if (interaction.kind === "choice") {
    return { kind: "hint", hint: CHOICE_CONTROL_HINT };
  }
  return interaction.level === "strong"
    ? { kind: "hint", hint: STRONG_HINT }
    : { kind: "answer", answer: { approved: true } };
}

export function matchAssistantChoiceText(
  options: readonly AssistantChoiceOption[],
  text: string,
): AssistantPauseMatch {
  return matchChoice(options, text, foldNameWords(text));
}

export function matchAssistantPauseAnswer(
  pause: AssistantPause,
  text: string,
): AssistantPauseMatch {
  const interaction = assistantInteractionFromPause(pause);
  if (interaction === null) {
    return { kind: "supersede" };
  }
  const control = controlWord(foldNameWords(text));
  if (control === "negative") {
    return { kind: "decline" };
  }
  if (interaction.kind === "confirmation") {
    return control === null
      ? { kind: "supersede" }
      : assistantAffirmedAnswer(interaction);
  }
  return control === "affirmative"
    ? assistantAffirmedAnswer(interaction)
    : matchAssistantChoiceText(interaction.options, text);
}
