import { INFLECTIONS } from "./lexicon/morphology.ts";
import { BY_WORDS, CAPITAL_UNITS, HALF_GLUED, RIM_WORDS, SPELLED_MEASURES, SUBUNITS, UNIT_ADJECTIVES, UNIT_KEYS, UNIT_PHRASES } from "./lexicon/units.ts";
import { NUMBER_FORMS, ZERO_WORDS } from "./lexicon/numbers.ts";
import { AND_NAMES, LETTER_NAMES } from "./lexicon/names.ts";
import { canonicalNumber, halvesJoined, numberWordKind, ordinalValue, wordNumberAt } from "./numbers.ts";
import { withRim } from "./tyres.ts";

// The tokens of a catalogue name or of words said, as they are compared (D64, D66): letters and digits apart («S24» → «s», «24»), a unit after a number by
// its key («256 гігабайт» → «256», «gb»), number words in digits («для двох геймпадів» → «для», «2», «геймпадів»; «сорок другий» → «42»), measures said
// in words («пів кіло» → «0.5», «kg»; «метровий» → «1», «m»; «метр двадцять» → «1.2», «m»; «кіло» alone → «1», «kg»), «на» between two numbers dropped
// («50 на 70»), and a tyre size's rim letter where it was not said («205 55 16» → «205», «55», «r», «16»). The same reading on both sides makes «три
// шоколади» the name «Три шоколади» and «пів літра» the value «0,5 л». A word joined by a hyphen keeps its number words («сім-карти» is no «7»), unless it
// is all numbers: a range («три-шість» → «3», «6», the value «3-6»). Since D67 a capital «А» / «В» after a number is the ampere / volt («16 А» → «16»,
// «a»), and so is a lowercase one that ends the words; «м²» and «м³» are units of their own («35 квадратних метрів» → «35», «m2»), and so are two-word
// units («10 погонних метрів» → «10», «m»).

const PIECES = /[0-9]+(?:[.,][0-9]+)?|[\p{L}']+[²³]?/gu;
const DIGITS = /^[0-9]+(?:[.,][0-9]+)?$/;
const COMPOUND = /[\p{L}\p{N}']-[\p{L}\p{N}']/u;
const LATIN_MARKS = /(?<=[a-z])\p{M}+/gu;
// Latin letters with marks, precomposed or not: only a text that has one is decomposed.
const ACCENTED = /[À-ɏ̀-ͯ]/;
// A capital «А» or «В» right after a number, with no letter glued after it and no number following («3 В 1» is «3 в 1», a two-in-one); in lowercase
// (speech, `normalise`) only when it ends the words («16 а», «220 в»): «2 а ні 3», «2 в коробці» keep the word.
const CAPITAL_UNIT = /(?<=[0-9]\s*)[АВ](?![\p{L}\p{N}])(?!\s*[0-9])/gu;
const LAST_UNIT = /(?<=[0-9]\s*)[ав]$/u;
// «м2», «м3» after a number: the square and cubic metre written with a digit («25 м2», «2,5 мм2»).
const POWER_DIGITS = /(?<=[0-9]\s*)(мм|см|м)([23])(?![\p{L}\p{N}])/gu;
const POWERS: Readonly<Record<string, string>> = { "2": "²", "3": "³" };
const HALF = 0.5;
const ONE_AND_HALF = 1.5;
const HALVES: ReadonlySet<string> = new Set(NUMBER_FORMS.half[HALF]?.split(" ") ?? []);
const ONES_AND_HALF: ReadonlySet<string> = new Set(NUMBER_FORMS.one_half[ONE_AND_HALF]?.split(" ") ?? []);
const ADJECTIVE_ENDINGS: readonly string[] = INFLECTIONS;
const TENS = 10;
// Units a decimal said with a zero first is measured in («ноль восемь миллиметра», «нуль п'ять літра»).
const DECIMAL_UNITS: ReadonlySet<string> = new Set(["mm", "cm", "m", "g", "kg", "l", "ml"]);
// A lone ordinal reads as its number from ten up (D71: «сімнадцяті» 17, «двухсотого» 200, the sizes «сімнадцятий», «п'ятдесятий»); «перший», «другий»,
// «третій» stay words (a second, another).
const LONE_ORDINAL = 10;
// Letter names of the metric thread «M» before its number («эм восемь» is «M8», D71), and of the rim «R» («ер сімнадцять» is «R17»).
const THREAD_LETTERS: ReadonlySet<string> = new Set(["ем", "эм", "em"]);
const RIM_LETTERS: ReadonlySet<string> = new Set(["р", "ер", "эр", "r"]);
const RIM_SIZES = [8, 24] as const;

interface Piece {
  readonly token: string;
  readonly compound: boolean;
  // A word of numbers joined by hyphens: a range («три-шість», «0-3»), whose numbers read one by one.
  readonly range: boolean;
}

// Lowercase, one apostrophe, and no accents on Latin letters («L'Oréal» → «l'oreal», «Président» → «president»); «й», «ї» stay, «ё» is «е» (D71: ru
// writes either, «зелёный» «зеленый»). A capital «А» / «В»
// after a number (or a lowercase one that ends the words) becomes the unit's key first, and «м2» becomes «м²».
function folded(text: string): string {
  const digits = /[0-9]/.test(text);
  const units = digits ? text.replace(CAPITAL_UNIT, (letter) => CAPITAL_UNITS.get(letter) ?? letter).replace(LAST_UNIT, (letter) => CAPITAL_UNITS.get(letter.toUpperCase()) ?? letter) : text;
  const quoted = units.toLowerCase().replace(/[’ʼ`]/g, "'").replace(/ё/g, "е");
  const lower = digits ? quoted.replace(POWER_DIGITS, (_, unit: string, power: string) => `${unit}${POWERS[power] ?? power}`) : quoted;
  return ACCENTED.test(lower) ? lower.normalize("NFD").replace(LATIN_MARKS, "").normalize("NFC") : lower;
}

function numberPart(part: string): boolean {
  return DIGITS.test(part) || numberWordKind(part) !== null;
}

function piecesOf(text: string): Piece[] {
  return halvesJoined(folded(text))
    .split(/\s+/)
    .flatMap((word) => {
      const compound = COMPOUND.test(word);
      const parts = word.split(/[-–]/).filter(Boolean);
      const range = compound && parts.length > 1 && parts.every(numberPart);
      return Array.from(word.matchAll(PIECES), (match): Piece => ({ token: match[0], compound, range }));
    });
}

function isDigits(token: string | undefined): boolean {
  return token !== undefined && DIGITS.test(token);
}

// A number in digits as the tokens write it: a decimal point, no trailing zeros («0,50» → «0.5»); a whole number as written («007»).
function numberToken(token: string): string {
  return /[.,]/.test(token) ? canonicalNumber(Number(token.replace(",", "."))) : token;
}

function unitOf(token: string | undefined): string | undefined {
  return token === undefined ? undefined : UNIT_KEYS.get(token);
}

// «півлітра», «полкило», «полтонны»: a half glued to a unit word.
function gluedHalf(token: string): string | undefined {
  const half = HALF_GLUED.find((prefix) => token.startsWith(prefix) && token.length > prefix.length + 1);
  return half === undefined ? undefined : unitOf(token.slice(half.length));
}

// «метровий», «літрова», «півлітрову»: an adjective of a unit, its value and the unit's key.
function unitAdjective(token: string): readonly [value: number, key: string] | undefined {
  for (const [stem, measure] of UNIT_ADJECTIVES) {
    if (token.startsWith(stem) && ADJECTIVE_ENDINGS.includes(token.slice(stem.length))) return measure;
  }
  return undefined;
}

// «сорок другий» → 42, «сто двадцятий» → 120, «двісті п'ятдесят восьмий» → 258, ru «сорок третьего» → 43: an ordinal after a round number whose zeros
// it fills (sizes; D71 beyond the tens).
function withOrdinal(value: number, words: readonly string[], end: number): readonly [value: number, end: number] {
  const next = words[end];
  const ordinal = next === undefined || isDigits(next) ? null : ordinalValue(next);
  if (ordinal === null || value < TENS * 2) return [value, end];
  const place = ordinal < TENS ? TENS : ordinal < TENS * TENS ? TENS * TENS : TENS * TENS * TENS;
  return value % place === 0 && ordinal < place ? [value + ordinal, end + 1] : [value, end];
}

// «ноль восемь миллиметра» → 0.8 mm, «ноль шестнадцать» → 0.16: a zero before a number said in words is a decimal fraction (D71) when the number has two
// digits or a length or weight follows; «нуль три» alone stays two numbers (the ages «0-3» months). Null when it is none.
function zeroDecimal(words: readonly string[], at: number): readonly [value: string, end: number] | null {
  if (!ZERO_WORDS.has(words[at] ?? "")) return null;
  const number = wordNumberAt(words, at + 1);
  if (number === null || !Number.isInteger(number[0]) || number[0] <= 0) return null;
  const unit = UNIT_KEYS.get(words[number[1]] ?? "");
  const measured = unit !== undefined && DECIMAL_UNITS.has(unit);
  return number[0] >= TENS || measured ? [`0.${String(number[0])}`, number[1]] : null;
}

// The words read as numbers where they are not joined by a hyphen, halves and unit adjectives read as measures.
function numbersRead(pieces: readonly Piece[]): string[] {
  const words = pieces.map((piece) => piece.token);
  const out: string[] = [];
  let at = 0;
  while (at < pieces.length) {
    const { token, compound, range } = pieces[at] ?? { token: "", compound: true, range: false };
    const next = words[at + 1];
    if (range) {
      const alone = numberWordKind(token) === null ? null : wordNumberAt([token], 0);
      out.push(alone === null ? token : canonicalNumber(alone[0]));
      at += 1;
      continue;
    }
    const glued = compound ? undefined : gluedHalf(token);
    const adjective = compound ? undefined : unitAdjective(token);
    const zero = compound ? null : zeroDecimal(words, at);
    const number = compound || numberWordKind(token) === null ? null : wordNumberAt(words, at);
    const ordinal = compound || number !== null ? null : ordinalValue(token);
    if (zero !== null) {
      out.push(zero[0]);
      at = zero[1];
    } else if (ordinal !== null && ordinal >= LONE_ORDINAL) {
      out.push(canonicalNumber(ordinal));
      at += 1;
    } else if (glued !== undefined) {
      out.push(String(HALF), glued);
      at += 1;
    } else if (adjective !== undefined) {
      out.push(String(adjective[0]), adjective[1]);
      at += 1;
    } else if (!compound && (HALVES.has(token) || ONES_AND_HALF.has(token)) && unitOf(next) !== undefined) {
      out.push(String(HALVES.has(token) ? HALF : ONE_AND_HALF));
      at += 1;
    } else if (number !== null) {
      const [value, end] = withOrdinal(number[0], words, number[1]);
      out.push(canonicalNumber(value));
      at = end;
    } else {
      out.push(token);
      at += 1;
    }
  }
  return out;
}

// «35 квадратних метрів» is «35 м²», «2 кубічних метри» «2 м³», «10 погонних метрів» «10 м», «25 кв м», «5 куб. м» «25 м²», «5 м³»: a two-word unit after a
// number as one (D67).
function unitPhrases(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? "";
    const phrase = isDigits(tokens[at - 1]) && unitOf(tokens[at + 1]) === "m" ? UNIT_PHRASES.find(([start]) => token.startsWith(start)) : undefined;
    if (phrase === undefined) out.push(token);
    else {
      out.push(phrase[1]);
      at += 1;
    }
  }
  return out;
}

// «кіло» alone is «1 kg»; «метр двадцять» is «1.2 m» (a unit said before the smaller units in it).
function spelledUnits(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at] ?? "";
    const key = SPELLED_MEASURES.has(token) && !isDigits(tokens[at - 1]) ? unitOf(token) : undefined;
    if (key === undefined) {
      out.push(token);
      continue;
    }
    const smaller = SUBUNITS.get(key);
    const next = tokens[at + 1];
    const part = smaller !== undefined && isDigits(next) && unitOf(tokens[at + 2]) === undefined ? Number(next) : NaN;
    if (smaller !== undefined && part >= smaller / TENS && part < smaller) {
      out.push(canonicalNumber(1 + part / smaller), key);
      at += 1;
    } else out.push("1", key);
  }
  return out;
}

function rimSize(token: string | undefined): boolean {
  return isDigits(token) && Number(token) >= RIM_SIZES[0] && Number(token) <= RIM_SIZES[1];
}

// A unit right after a number by its key; «на» and «x» between two numbers dropped; «радіус» before a number is the rim letter, and so is «р», «ер»
// before a rim size («ер дванадцять» → «r», «12», D71); «ем» before a number is the thread «M» («эм восемь на сорок» → «m», «8», «40», D71).
function unitsAndSizes(tokens: readonly string[]): string[] {
  const keyed = tokens.map((token, index) => (index > 0 && isDigits(tokens[index - 1]) ? (unitOf(token) ?? token) : token));
  return keyed.flatMap((token, index) => {
    if (BY_WORDS.has(token) && isDigits(keyed[index - 1]) && isDigits(keyed[index + 1])) return [];
    if ((RIM_WORDS.has(token) && isDigits(keyed[index + 1])) || (RIM_LETTERS.has(token) && rimSize(keyed[index + 1]))) return ["r"];
    if (THREAD_LETTERS.has(token) && isDigits(keyed[index + 1])) return ["m"];
    return [isDigits(token) ? numberToken(token) : token];
  });
}

// «аш енд ем»: «енд» between two letters said by name is the «&» the name's tokens leave out (D71).
function withoutAnd(tokens: readonly string[]): string[] {
  const letter = (token: string | undefined) => token !== undefined && (LETTER_NAMES.has(token) || /^[a-z]$/.test(token));
  return tokens.filter((token, at) => !(AND_NAMES.has(token) && letter(tokens[at - 1]) && letter(tokens[at + 1])));
}

// Tokens already read: a catalogue repeats its values («Чорний», «500 г») and the segmenter reads the same runs of words again.
const TOKENS = new Map<string, readonly string[]>();
const TOKENS_KEPT = 100_000;

export function nameTokens(text: string): string[] {
  const known = TOKENS.get(text);
  if (known !== undefined) return [...known];
  if (TOKENS.size >= TOKENS_KEPT) TOKENS.clear();
  const tokens = withRim(unitsAndSizes(spelledUnits(unitPhrases(withoutAnd(numbersRead(piecesOf(text)))))));
  TOKENS.set(text, tokens);
  return [...tokens];
}
