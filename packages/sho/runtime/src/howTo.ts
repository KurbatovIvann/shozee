import { intentOfAction, type Bundle } from "./bundle.ts";
import {
  APP_WORDS, BUTTON_DETERMINERS, BUTTON_WORDS, COMPARATIVES, HOW_CLAUSE_ENDS, HOW_CUES, HOW_NOT_NEXT, HOW_REACH, HOW_SUBJECTS, HOW_WORDS_RU,
  HOW_WORDS_UK, HOW_WORKS, INFINITIVE_MIN, INFINITIVE_RU, INFINITIVE_UK, MAY_WORDS, NOT_INFINITIVES, NUMERAL_ENDINGS, QUESTION_FILLERS,
  QUESTION_FILLERS_MAX, WHAT_CUES, WHAT_THIS, WHAT_WORDS, WHERE_DETERMINERS, WHERE_PREPOSITIONS, WHERE_WORDS,
} from "./lexicon/questions.ts";
import { NO_COMMAND } from "./references.ts";
import type { CommandV2, Need } from "./result.ts";

// D97 (Q1 of docs/research/v35-served-2026-09-30.md, owner-approved 2026-10-01): a question about the app itself — how to do something in it, what
// something is, where something is in it — is no command. The model always picks one of its actions, and a how-to question names one: dictation
// v5 none-21 (a how-to question about order confirmations) was v3.5's ready `orders.confirm` (0.951), and with a host focus D88 still bound the
// bare «клієнту» to the focused customer. A command whose words open (past `QUESTION_FILLERS`) with
//   - «як / как» and «мені / мне / нам / тут / здесь», «(це) працює», or an infinitive within four words («як додати …», «как в этом разделе
//     выгрузить …»), not «як завжди / як тільки / як можна швидше / як справи / як щодо …» (`HOW_NOT_NEXT`);
//   - «що таке / що це таке / що означає / что такое / что значит»;
//   - «де / где» with the app after a preposition («де в застосунку», «где в этом приложении») or a button («де ця кнопка»)
// and has no digit is served as `none`: no params, ready, the non-blocking need `{path: "text", reason: "how_to", span: {text: <the question words>}}`,
// the host's dialogue model answers it. When the model read `none` itself, its command and confidence stand and only the need is added; when it read an
// action, the confidence is D93's 0 (the `none` is not the model's reading). Its D81 `unparsed` words stay, never blocking. A number said with the
// question («як видалити документ 512») leaves the model's reading: the training data reads those as the command.

const DIGIT = /\p{Nd}/u;
const HOW_TO = "how_to";

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function infinitive(word: string, russian: boolean): boolean {
  if (word.length < INFINITIVE_MIN || NOT_INFINITIVES.has(word) || NUMERAL_ENDINGS.some((ending) => word.endsWith(ending))) return false;
  return (russian ? INFINITIVE_RU : INFINITIVE_UK).test(word);
}

// The question words of a how-question opening at `at` («як мені», «як … додати», «как … поменять», «як це працює»), or null.
function howCue(said: readonly string[], at: number): string | null {
  const word = said[at] ?? "";
  const russian = HOW_WORDS_RU.has(word);
  if (!russian && !HOW_WORDS_UK.has(word)) return null;
  const next = said[at + 1];
  if (next === undefined || HOW_NOT_NEXT.has(next)) return null;
  if (MAY_WORDS.has(next) && COMPARATIVES.has(said[at + 2] ?? "")) return null;
  if (HOW_CUES.has(next) || HOW_WORKS.has(next)) return `${word} ${next}`;
  if (HOW_SUBJECTS.has(next) && HOW_WORKS.has(said[at + 2] ?? "")) return said.slice(at, at + 3).join(" ");
  for (let index = at + 1; index <= at + HOW_REACH && index < said.length; index++) {
    const found = said[index] ?? "";
    if (index > at + 1 && HOW_CLAUSE_ENDS.has(found)) return null;
    if (infinitive(found, russian)) return said.slice(at, index + 1).join(" ");
  }
  return null;
}

function whatCue(said: readonly string[], at: number): string | null {
  if (!WHAT_WORDS.has(said[at] ?? "")) return null;
  const cue = WHAT_THIS.has(said[at + 1] ?? "") ? at + 2 : at + 1;
  return WHAT_CUES.has(said[cue] ?? "") ? said.slice(at, cue + 1).join(" ") : null;
}

function whereCue(said: readonly string[], at: number): string | null {
  if (!WHERE_WORDS.has(said[at] ?? "")) return null;
  let index = at + 1;
  if (BUTTON_DETERMINERS.has(said[index] ?? "")) index++;
  if (BUTTON_WORDS.has(said[index] ?? "")) return said.slice(at, index + 1).join(" ");
  if (!WHERE_PREPOSITIONS.has(said[at + 1] ?? "")) return null;
  index = WHERE_DETERMINERS.has(said[at + 2] ?? "") ? at + 3 : at + 2;
  return APP_WORDS.has(said[index] ?? "") ? said.slice(at, index + 1).join(" ") : null;
}

// The question words when `text` (normalised) is a question about the app, else null.
export function howToQuestion(text: string): string | null {
  if (DIGIT.test(text)) return null;
  const said = words(text);
  let at = 0;
  while (at < said.length && at < QUESTION_FILLERS_MAX && QUESTION_FILLERS.has(said[at] ?? "")) at++;
  return howCue(said, at) ?? whatCue(said, at) ?? whereCue(said, at);
}

// The command a question about the app is served as; the command itself when it is none, or when the bundle has no `none` action.
export function asHowTo(bundle: Bundle, command: CommandV2): CommandV2 {
  const cue = howToQuestion(command.text);
  if (cue === null || !Object.hasOwn(bundle.intents, NO_COMMAND)) return command;
  const need: Need = { path: "text", reason: HOW_TO, blocking: false, span: { text: cue } };
  const unparsed = command.needs.filter((left) => left.reason === "unparsed").map((left) => ({ ...left, blocking: false }));
  if (command.action === NO_COMMAND) return { ...command, needs: [need, ...command.needs.filter((left) => left.reason !== "unparsed"), ...unparsed], ready: true };
  const { action, intent } = intentOfAction(bundle, NO_COMMAND);
  return {
    text: command.text,
    action,
    kind: intent.kind,
    effect: "none",
    confirm: "none",
    params: {},
    needs: [need, ...unparsed],
    ready: true,
    refPrevious: {},
    catalogued: false,
    confidence: { action: 0, margin: 0, certainty: 0, spans: 1 },
    ...(command.debug === undefined ? {} : { debug: command.debug }),
  };
}
