import type { CatalogPickerConflictExtras } from "../choice.js";
import type { JudgmentProvider, JudgmentText } from "./types.js";

export const JUDGMENT_PICKER_THRESHOLD = 0.9;
export const JUDGMENT_PICKER_ANSWERS_MAX = 4;

const UNCLEAR = "unclear";
const NONE_OF_THEM = "none";

export async function answerPickerFromMessage(args: {
  readonly provider: JudgmentProvider;
  readonly message: string;
  readonly picker: CatalogPickerConflictExtras;
  readonly line?: string;
  readonly signal?: AbortSignal;
}): Promise<string | undefined> {
  const labels = args.picker.options.map((option) => option.label);
  if (
    new Set(labels).size !== labels.length ||
    labels.includes(UNCLEAR) ||
    labels.includes(NONE_OF_THEM)
  ) {
    return undefined;
  }
  const criteria: Record<string, JudgmentText | null> = {};
  for (const label of labels) {
    criteria[label] = null;
  }
  criteria[UNCLEAR] =
    "Two or more of them fit what the message says equally well, or the message does not say which.";
  criteria[NONE_OF_THEM] = "The message means none of them.";
  const target = args.picker.target;
  const isVariant = !("query" in target);
  const result = await args.provider.ask(
    {
      state: {
        message: args.message,
        ...(isVariant
          ? { product: target.productName }
          : { mention: target.query }),
        ...(args.line === undefined ? {} : { line: args.line }),
      },
      questions: {
        pick: {
          type: "choice",
          instructions: isVariant
            ? `\`message\` is what a staff member typed to create an order. The order line \`line\` is for \`product\`, which is sold only in variants. Which variant does \`message\` ask for on that line? The message may name it inflected, as an adjective, shortened or misspelled. Choose \`${UNCLEAR}\` when the message names no variant for that line.`
            : `\`message\` is what a staff member typed to create an order. The system looked up \`mention\` and found these stored records. Which one does \`message\` mean? The message may name it inflected, in another word order, shortened or misspelled. Choose \`${UNCLEAR}\` when the message does not say enough to tell them apart.`,
          criteria,
        },
      },
    },
    args.signal === undefined ? {} : { signal: args.signal },
  );
  if (
    !result.ok ||
    result.answers.pick.confidence < JUDGMENT_PICKER_THRESHOLD
  ) {
    return undefined;
  }
  return args.picker.options.find(
    (option) => option.label === result.answers.pick.choice,
  )?.id;
}
