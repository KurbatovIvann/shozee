import { intentOfAction, type Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { RecordList } from "./context.ts";
import { nameTokens } from "./nameTokens.ts";
import type { Previous } from "./refine.ts";
import type { CommandV2 } from "./result.ts";
import { NO_COMMAND } from "./references.ts";

// D93 (family 7 of Shozee's SHO-740 routing check, owner-approved 2026-09-30: «немає жодного кириличного слова — не наше»). The model knows only
// Ukrainian and Russian and always picks one of its actions: «Thanks a lot, that was helpful!» and «What can you help me with?» were `orders.create`
// at 0.98–0.99, so a host that routes by confidence never sent them to its dialogue model. An utterance with a letter and no Cyrillic letter (English,
// a transliteration «stvory zamovlennya») is not read: `run` serves one command, `none`, with confidence 0 and the non-blocking need
// `{path: "text", reason: "language"}`. The words as given are checked, so the «номер» `normalise` writes for «No. 5» is no Cyrillic word. Latin words
// among Cyrillic ones («додай iPhone 15 Шерлоку», «покажи замовлення crumb & co») are read as before; so is an utterance with no letter at all
// («120», «0987654321», «+380…»): a number is the answer to a card, which the model reads as `ui.pick`.

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LETTER = /\p{L}/u;

// `said`: the utterance as given (the raw text, or the text): a letter, and no Cyrillic one. «№ 12» has none («№» is a sign), «No. 12» has.
export function foreignLanguage(said: string): boolean {
  return LETTER.test(said) && !CYRILLIC.test(said);
}

// D93 addendum (owner-approved 2026-09-30): a Latin-only utterance is still read by the model when it is a short answer to a card that asked, or a
// name the shop's context knows whole:
//   1. the host passed `previous` (D78) and that command asked the person something: it has a blocking need (`ambiguous`, `missing`, `reference`,
//      `check_reference`, `variant_required`, `unknown` …), and the utterance is at most `CARD_ANSWER_WORDS` words once normalised («XL», «ok»,
//      «lavazza», «flat white»); no clock: the host passes `previous` while its card is open;
//   2. the whole utterance, normalised, is the whole name or an alias of a product, a variant's value, a customer, a group, a price list or a
//      counterparty of the context (the catalogue's `find` with a whole fit; the lists' whole hits): «lavazza» when Lavazza is a product, «xl» when XL
//      is a variant's value. A part of a name, a prefix or a name inside a sentence is no match.
// An English sentence is neither: longer than three words with a card open, and never a record's whole name.
export const CARD_ANSWER_WORDS = 3;
const NAMED_LISTS: readonly RecordList[] = ["customers", "groups", "priceLists", "counterparties"];

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// The previous command asked the person something (a blocking need), and the text is short enough to be its answer.
export function answersCard(text: string, previous: Previous | null): boolean {
  return previous !== null && previous.command.needs.some((need) => need.blocking) && wordsOf(text).length <= CARD_ANSWER_WORDS;
}

// The whole text is the whole name (or an alias) of a record of the context, or a variant's value.
export function namesRecord(text: string, context: CompiledContext | null): boolean {
  if (context === null) return false;
  const words = wordsOf(text);
  if (!words.length) return false;
  if (context.find(words)?.fit === "whole") return true;
  return nameTokens(text).length > 0 && NAMED_LISTS.some((list) => (context.records.lists[list]?.hits(text).whole.length ?? 0) > 0);
}

// The command a foreign-language utterance is served as; null when the bundle has no `none` action (then the model reads it as before).
export function languageCommand(bundle: Bundle, text: string): CommandV2 | null {
  if (!Object.hasOwn(bundle.intents, NO_COMMAND)) return null;
  const { action, intent } = intentOfAction(bundle, NO_COMMAND);
  return {
    text,
    action,
    kind: intent.kind,
    effect: "none",
    confirm: "none",
    params: {},
    needs: [{ path: "text", reason: "language", blocking: false }],
    ready: true,
    refPrevious: {},
    catalogued: false,
    confidence: { action: 0, margin: 0, certainty: 0, spans: 1 },
  };
}
