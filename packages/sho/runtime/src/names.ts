import { CONNECTORS, LABEL_WORDS, PREPOSITIONS } from "./lexicon/catalogue.ts";
import { CUSTOMER_LEADS } from "./lexicon/customers.ts";
import { ASR_SLIPS, BRAND_EXONYMS, CROSS_STEMS, LETTER_NAMES, SIZE_LETTERS, type CrossKind } from "./lexicon/names.ts";
import { INFLECTIONS } from "./lexicon/morphology.ts";
import { SPEC_UNITS, UNIT_KEYS } from "./lexicon/units.ts";
import { measureAt, sameMeasure } from "./measures.ts";
import { nameMatch } from "./nameList.ts";
import { sameWord } from "./morphology.ts";
import { SHORTEST_SOUNDED, soundKey, sounds, soundsLike } from "./sounds.ts";
import { wordMatch } from "./words.ts";

export { nameTokens } from "./nameTokens.ts";
export { SHORTEST_SOUNDED, latinLetters, soundKey, soundKeys, soundStems } from "./sounds.ts";

// Catalogue names as people say them (D64): a name is compared token by token, a token said in one script with one written in the other by its sound.

const DIGITS = /^[0-9]+(?:[.,][0-9]+)?$/;
const LATIN = /^[a-z']+$/;
const CYRILLIC = /^[\p{Script=Cyrillic}']+$/u;
// A phrase matched by sound alone needs this many consonant sounds, so that one short word («про», «ейр») never names a product by itself.
const SOUNDS_ENOUGH = 3;

export function isNumber(token: string): boolean {
  return DIGITS.test(token);
}

export function isLatin(token: string): boolean {
  return LATIN.test(token);
}

export function isCyrillic(token: string): boolean {
  return CYRILLIC.test(token);
}

const EXONYM_PARTNERS: ReadonlyMap<string, readonly string[]> = (() => {
  const partners = new Map<string, string[]>();
  const add = (word: string, partner: string) => partners.set(word, [...(partners.get(word) ?? []), partner]);
  for (const [name, spoken] of BRAND_EXONYMS) {
    for (const said of spoken) {
      add(name, said);
      add(said, name);
    }
  }
  return partners;
})();

// The words a listed exonym pairs with the token, either way round (`BRAND_EXONYMS`).
export function exonymPartners(token: string): readonly string[] {
  return EXONYM_PARTNERS.get(token) ?? [];
}

function exonym(spoken: string, known: string): boolean {
  return exonymPartners(spoken).includes(known);
}

// A Cyrillic word said for a Latin catalogue word: brands are written in Latin and said in Cyrillic («найк» Nike). The other way round only a listed exonym
// matches a name: a Latin word the recogniser writes is most often a foreign name the catalogue does not have («tarte горіх» is no «торт», lh-314). An alias
// is the shop's own spoken form, so a Latin word said for a Cyrillic alias word is compared by sound as well («iphone» for the alias «заміна батареї айфон»,
// D66).
function saidInCyrillic(spoken: string, known: string): boolean {
  return CYRILLIC.test(spoken) && LATIN.test(known);
}

function crossScript(spoken: string, known: string): boolean {
  return saidInCyrillic(spoken, known) || (LATIN.test(spoken) && CYRILLIC.test(known));
}

// How a catalogue name is written (D66): `alias`, the shop's own spoken form; `proper`, the name of a customer, group, price list or counterparty, whose
// words are compared as names are (D56: the Russian spelling, «того» for «ТОВ»).
export interface Written {
  readonly alias?: boolean;
  readonly proper?: boolean;
}

const PLAIN: Written = {};

function bySound(spoken: string, known: string, written: Written): boolean {
  if (exonym(spoken, known)) return true;
  if (saidInCyrillic(spoken, known)) return soundsLike(spoken, known);
  return written.alias === true && soundsLike(known, spoken);
}

export type TokenMatch = "same" | "sound" | null;

const APOSTROPHES = /'/g;

// The word without the apostrophes it is written with: «в'язану» and «в'язана» are word forms of one word.
export function withoutApostrophes(token: string): string {
  return token.replace(APOSTROPHES, "");
}

// Word forms the stem rule (`wordMatch`) misses: words with an apostrophe (D65), and forms of one word by its paradigm (D66, `morphology.ts`: «ручок»
// «ручка», «ножів» «ніж», «білого» «білий», «синюю» «синяя»).
function formMatch(spoken: string, known: string): boolean {
  const said = withoutApostrophes(spoken);
  const name = withoutApostrophes(known);
  if ((said !== spoken || name !== known) && wordMatch(said, name)) return true;
  return sameWord(said, name);
}

// A spoken token for a catalogue token: a number only for the same number, a word of the same script by the stem rule (`wordMatch`, and `formMatch`; uk and
// ru spellings are not folded as customer names are: ru «фисташек» would name uk «фісташковий»; only a stem vowel after a shared start of four letters
// may differ, «пломбір» «пломбир», D66), a word the recogniser writes for another (`ASR_SLIPS`), a word of the other script by its sound; a word of a
// proper name as names match (`nameMatch`).
// A Cyrillic letter name for a one-letter Latin token («аш» h, «ве» w, D71).
function letterNamed(spoken: string, known: string): boolean {
  return known.length === 1 && LATIN.test(known) && (LETTER_NAMES.get(spoken)?.includes(known) ?? false);
}

interface CrossForm {
  readonly form: string;
  readonly stem: string;
  readonly kind: CrossKind;
}

// A word with its stem put in the other language (`CROSS_STEMS`, D71): «черных» → «чорних», «чорниця» → «черниця», «клубничный» → «полуничный».
function crossReadings(word: string): CrossForm[] {
  const said = withoutApostrophes(word).replace(/ё/g, "е");
  const found: CrossForm[] = [];
  for (const [uk, ru, kind] of CROSS_STEMS) {
    const left = withoutApostrophes(uk);
    if (left === ru) continue;
    if (said.startsWith(left)) found.push({ form: `${ru}${said.slice(left.length)}`, stem: ru, kind });
    if (said.startsWith(ru)) found.push({ form: `${left}${said.slice(ru.length)}`, stem: left, kind });
  }
  return found;
}

export function crossForms(word: string): string[] {
  return crossReadings(word).map((reading) => reading.form);
}

// A uk word for a ru word of another stem, or the other way round (D71): the known word starts with the other stem, and the word with its stem put in the
// other language is a form of it (a colour only by its ending).
function crossStem(spoken: string, known: string): boolean {
  const name = withoutApostrophes(known).replace(/ё/g, "е");
  return crossReadings(spoken).some(({ form, stem, kind }) => {
    if (!name.startsWith(stem)) return false;
    if (kind === "colour") return INFLECTIONS.includes(form.slice(stem.length)) && INFLECTIONS.includes(name.slice(stem.length));
    return wordMatch(form, name) || sameWord(form, name);
  });
}

// Prepositions that alternate by sound: «у сиропі» / «в сиропі», «з» / «із» / «зі», ru «с» / «со» (D71).
export const PREPOSITION_FORMS: readonly ReadonlySet<string>[] = [new Set(["у", "в", "уві", "во"]), new Set(["з", "із", "зі", "с", "со"])];

// D73: one word in its other spellings (the recogniser writes uk or ru letters, «серавэ» for the alias «серавє»): the ru-only letters «э», «ё», «ы» as
// «е», «е», «и», «ьй» as «ь» («лосьйон» «лосьон») and no apostrophes, at any length; a long word (six letters or more) also with «і», «ї», «є» folded
// as names are («бисквитный» «бісквітний»). Short words keep the uk / ru vowels apart («сірий» is no «сирий»).
const SPELLING_LENGTH = 6;
const SHORT_SPELLED = 5;
const RU_LETTERS: ReadonlyMap<string, string> = new Map([["э", "е"], ["ё", "е"], ["ы", "и"]]);
const UK_LETTERS: ReadonlyMap<string, string> = new Map([["і", "и"], ["ї", "и"], ["є", "е"]]);

export function spelled(word: string, folded = false): string {
  return Array.from(withoutApostrophes(word).replace(/ьй/g, "ь"), (letter) => RU_LETTERS.get(letter) ?? (folded ? UK_LETTERS.get(letter) : undefined) ?? letter).join("");
}

function spellingMatch(spoken: string, known: string): boolean {
  if (!CYRILLIC.test(spoken) || !CYRILLIC.test(known)) return false;
  const said = spelled(spoken);
  const name = spelled(known);
  // A short word only as a whole: «сын» is no «синій».
  const short = Array.from(said).length < SHORT_SPELLED || Array.from(name).length < SHORT_SPELLED;
  if ((said !== spoken || name !== known) && (said === name || (!short && (wordMatch(said, name) || sameWord(said, name))))) return true;
  if (Array.from(spoken).length < SPELLING_LENGTH || Array.from(known).length < SPELLING_LENGTH) return false;
  const folded = spelled(spoken, true);
  const other = spelled(known, true);
  return folded === other || sameWord(folded, other);
}

export function tokenMatch(spoken: string, known: string, written: Written = PLAIN): TokenMatch {
  if (spoken === known) return "same";
  if (PREPOSITION_FORMS.some((forms) => forms.has(spoken) && forms.has(known))) return "same";
  if (isNumber(spoken) || isNumber(known)) return null;
  if (ASR_SLIPS.get(spoken) === known || letterNamed(spoken, known)) return "same";
  if (CYRILLIC.test(spoken) && CYRILLIC.test(known) && crossStem(spoken, known)) return "same";
  if (crossScript(spoken, known)) return bySound(spoken, known, written) ? "sound" : null;
  return wordMatch(spoken, known) || formMatch(spoken, known) || spellingMatch(spoken, known) || (written.proper === true && nameMatch(spoken, known)) ? "same" : null;
}

const SIZE = /^(?:x{0,3}[sl]|m)$/;

// A letter size spelled by letter names, at least one of them in Cyrillic: «ем» → «m», «ікс ел» → «xl», «м» → «m»; null for anything else.
export function spelledSize(spoken: readonly string[]): string | null {
  const letters = spoken.map((token) => SIZE_LETTERS.get(token));
  if (!letters.length || !spoken.some(isCyrillic) || letters.some((letter) => letter === undefined)) return null;
  const size = letters.join("");
  return SIZE.test(size) ? size : null;
}

// Tokens said for tokens known, in order: null when any pair differs; else whether every word matched by sound alone is enough for a name. A number and its
// unit match the same measure in another unit («500 g» the known «0.5 kg», D66).
export function tokensMatch(spoken: readonly string[], known: readonly string[], written: Written = PLAIN): boolean {
  if (spoken.length !== known.length) return false;
  let sound = 0;
  let same = 0;
  for (let index = 0; index < spoken.length; index++) {
    const said = measureAt(spoken, index);
    const name = measureAt(known, index);
    if (said !== null && name !== null && said.dimension === name.dimension) {
      if (!sameMeasure(said, name)) return false;
      same += 1;
      index += 1;
      continue;
    }
    // A measure's unit is matched as a unit only: «5 ем» is no «5 м» (D71: a letter said by name is no unit key).
    if (name !== null && said === null && isNumber(spoken[index] ?? "")) return false;
    const found = tokenMatch(spoken[index] ?? "", known[index] ?? "", written);
    if (found === null) return false;
    if (found === "sound") sound += sounds(soundKey(known[index] ?? ""));
    else same += 1;
  }
  return sound === 0 || same > 0 || sound >= SOUNDS_ENOUGH;
}

// Words that never make a part of a name on their own: a preposition, a joiner, a label or «для» (`nameFit`).
export const PART_STOPS: ReadonlySet<string> = new Set([...PREPOSITIONS, ...CONNECTORS, ...LABEL_WORDS, ...CUSTOMER_LEADS]);
// How many letters a part of a name must say, stop words left out: «air max» names «Nike Air Max 90», «pro» alone names nothing.
const PART_LETTERS = 4;
const LONGEST_REORDERED = 3;
const SPEC_TOKENS: ReadonlySet<string> = new Set(Array.from(SPEC_UNITS, (unit) => UNIT_KEYS.get(unit) ?? unit));

export type NameFit = "whole" | "part";

// A stop word at `at`, except a one-letter label before a number: «р50» is the model R50, «р15» the rim R15, not the size label «р.» (D66).
function stopAt(tokens: readonly string[], at: number): boolean {
  const token = tokens[at] ?? "";
  return PART_STOPS.has(token) && !(Array.from(token).length === 1 && LABEL_WORDS.has(token) && isNumber(tokens[at + 1] ?? ""));
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

// «вечірню сукню» for «сукня вечірня»: the words of a short name of words only in another order (a noun and its adjective). A name with a number keeps its
// order: «400 мл смузі» is no «Смузі 400 мл», «12 коробки» no «Коробка 12».
function reordered(spoken: readonly string[], known: readonly string[], written: Written): boolean {
  if (spoken.length !== known.length || known.length < 2 || known.length > LONGEST_REORDERED || known.some(isNumber)) return false;
  return permutations(spoken).some((order) => tokensMatch(order, known, written));
}

// A part says enough to name its name when it says the brand or model: its run of the name holds a word in Latin letters («Air Max 90», «Kerastase», «Galaxy
// S24», said in either script), it starts and ends on no stop word and has enough letters. A Cyrillic word alone («маска», «ягід») is no part: in a real
// catalogue it fits a flavour or another product as well. A number is a part only of a variant that adds a unit no quantity is said in («128» of «128 ГБ»,
// «120» of «120 см»; «2» is no part of «2 л»).
function saysEnough(spoken: readonly string[], known: readonly string[], at: number): boolean {
  const run = known.slice(at, at + spoken.length);
  if (spoken.every(isNumber)) return known.every((token, index) => (index >= at && index < at + spoken.length) || SPEC_TOKENS.has(token));
  if (stopAt(spoken, 0) || stopAt(spoken, spoken.length - 1)) return false;
  const letters = spoken.filter((token, index) => !isNumber(token) && !stopAt(spoken, index)).join("").length;
  return letters >= PART_LETTERS && run.some((token) => LATIN.test(token) && token.length >= SHORTEST_SOUNDED);
}

// Spoken tokens against a catalogue name's tokens: the whole name (in order, or a short name's words in another order), a part of it (a run of its tokens that
// says enough: «Air Max 90» of «Nike Air Max 90», «kerastase» of «шампунь Kerastase», «128» of «128 ГБ»), or neither.
export function nameFit(spoken: readonly string[], known: readonly string[], written: Written = PLAIN): NameFit | null {
  if (tokensMatch(spoken, known, written) || reordered(spoken, known, written)) return "whole";
  if (known.length === 1 && spelledSize(spoken) === known[0]) return "whole";
  for (let at = 0; at + spoken.length <= known.length && spoken.length < known.length; at++) {
    if (tokensMatch(spoken, known.slice(at, at + spoken.length), written) && saysEnough(spoken, known, at)) return "part";
  }
  return null;
}
