import {
  AND_WORDS,
  COUPLE,
  COUPLE_PIECES,
  COUPLE_WORDS,
  DAY_WORDS,
  WEEK_WORDS,
  WITHIN_WORDS,
  LONG_ENDING_STEMS,
  HALF_AFTER,
  HALF_PREFIXES,
  HRYVNIA_PREFIXES,
  KOPECK_PREFIX,
  LAST_WORDS,
  PERCENT_WORDS,
  NUMBER_FORMS,
  NUMBER_WORD_KINDS,
  ORDINAL_ENDINGS,
  ORDINAL_STEMS,
  ZERO_FEW,
  ZERO_MANY,
  type NumberWordKind,
} from "./lexicon/numbers.ts";
import { SPAN_SINGLE_UNITS, UNITS } from "./lexicon/units.ts";

export type NumberKind = NumberWordKind | "digits" | "glued_half";

export type NumberToken = readonly [word: string, start: number, end: number];

export type LastDays = readonly [value: number, start: number, end: number];

type FollowKind = "unit" | "teen" | "ten" | "hundred";

type Last = FollowKind | "digits" | "mult" | "half" | null;

interface Classified {
  readonly kind: NumberKind | null;
  readonly value: number;
}

const FILL = "*";
const IBAN_DIGITS = 27;
const FOLLOWS: Readonly<Record<FollowKind, ReadonlySet<Last>>> = {
  unit: new Set<Last>([null, "mult", "hundred", "ten"]),
  teen: new Set<Last>([null, "mult", "hundred"]),
  ten: new Set<Last>([null, "mult", "hundred"]),
  hundred: new Set<Last>([null, "mult"]),
};
const QUANTITY = "quantity";
const NUMBER_KINDS: ReadonlySet<string> = new Set([QUANTITY, "order_number", "document_ref", "max_uses"]);
const PERCENT = "percent";
// Kopecks said after the hryvnias with no word for them («дві гривні сорок»): fewer than a hryvnia.
const KOPECKS_IN_HRYVNIA = 100;
// A group of digits after a thousands word («6 тисяч 200»): fewer than a thousand.
const BELOW_THOUSAND = 1000;
const MONEY_KINDS: ReadonlySet<string> = new Set(["amount", "price"]);
const DIGIT_KINDS: ReadonlySet<string> = new Set(["phone", "edrpou", "mfo"]);
const NUMBER_TOKEN = /\+?[0-9]+(?:[.,][0-9]+)?|[a-zа-яіїєґё']+/g;

function numberWordTable(): Readonly<Record<string, readonly [NumberWordKind, number]>> {
  const table: Record<string, readonly [NumberWordKind, number]> = {};
  for (const kind of NUMBER_WORD_KINDS) {
    for (const [value, forms] of Object.entries(NUMBER_FORMS[kind])) {
      for (const form of forms.split(" ")) if (!Object.hasOwn(table, form)) table[form] = [kind, Number(value)];
    }
  }
  return table;
}

export const NUMBER_WORDS = numberWordTable();

function isFollowKind(kind: NumberKind | null): kind is FollowKind {
  return kind === "unit" || kind === "teen" || kind === "ten" || kind === "hundred";
}

export function cleanNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(Number(value) * 1000000) / 1000000;
}

// «ё» is «е» (D71: ru writes either); the number words list both where they differ («трёх» «трех»).
export function numberTokens(text: string): NumberToken[] {
  const lowered = text.toLowerCase().replace(/[’ʼ`′´]/g, "'").replace(/ё/g, "е");
  return Array.from(lowered.matchAll(NUMBER_TOKEN), (match) => [match[0], match.index, match.index + match[0].length] as const);
}

function gluedHalf(word: string): boolean {
  return !Object.hasOwn(NUMBER_WORDS, word) && word.length > 4 && HALF_PREFIXES.some((prefix) => word.startsWith(prefix));
}

function classifyNumber(word: string): Classified {
  const head = word[0];
  if (head !== undefined && "0123456789+".includes(head)) return { kind: "digits", value: Number(word.replace(/^\+/, "").replace(",", ".")) };
  const known = Object.hasOwn(NUMBER_WORDS, word) ? NUMBER_WORDS[word] : undefined;
  if (known !== undefined) return { kind: known[0], value: known[1] };
  if (gluedHalf(word)) return { kind: "glued_half", value: 0.5 };
  return { kind: null, value: Number.NaN };
}

function isNumeric(word: string): boolean {
  return classifyNumber(word).kind !== null;
}

function halfFollows(words: readonly string[], index: number): boolean {
  return index + 1 < words.length && AND_WORDS.has(words[index] ?? "") && HALF_AFTER.has(words[index + 1] ?? "");
}

function readCardinal(words: readonly string[], start: number): readonly [value: number, end: number] {
  let total = 0;
  let group = 0;
  let last: Last = null;
  let index = start;
  while (index < words.length) {
    const word = words[index] ?? "";
    const { kind, value } = classifyNumber(word);
    if (kind === "digits" && last === null) {
      group = value;
      last = "digits";
    } else if (kind === "digits" && last === "digits" && /^[0-9]{3}$/.test(word) && /^\+?[0-9]+$/.test(words[index - 1] ?? "")) {
      group = group * 1000 + value;
    } else if (isFollowKind(kind) && FOLLOWS[kind].has(last)) {
      group += value;
      last = kind;
    } else if (kind === "digits" && last === "mult" && Number.isInteger(value) && value < BELOW_THOUSAND) {
      group = value;
      last = "digits";
    } else if (kind === "mult" && last !== "mult") {
      total += (last !== null ? group : 1) * value;
      group = 0;
      last = "mult";
    } else if ((kind === "half" || kind === "one_half") && last === null) {
      group = value;
      last = "half";
    } else if (kind === "glued_half" && last === null) {
      return [value, index + 1];
    } else if (last !== null && halfFollows(words, index)) {
      return [total + group + 0.5, index + 2];
    } else {
      break;
    }
    index += 1;
  }
  return [total + group, index];
}

// A cardinal said in words starting at `start` («двісті п'ять», «сорок», «одну»): its value and the index after it; null when the word there is no number
// word (digits, halves and anything else). `nameTokens.ts` reads number words inside names with it (D66).
export function wordNumberAt(words: readonly string[], start: number): readonly [value: number, end: number] | null {
  const kind = classifyNumber(words[start] ?? "").kind;
  if (kind === null || kind === "digits" || kind === "half" || kind === "one_half" || kind === "glued_half") return null;
  const [value, end] = readCardinal(words, start);
  return end > start ? [value, end] : null;
}

// The kind of one number word («сорок» ten, «сто» hundred), null for any other word.
export function numberWordKind(word: string): NumberKind | null {
  return classifyNumber(word).kind;
}

// An ordinal said as a word («сорок третього» is «третього» 3 after «сорок»; «двухсотого» 200, «сімнадцяті» 17): its value, null for any other word (D71).
// Ordinals already read: the name tokens ask about every word of every catalogue name.
const ORDINALS = new Map<string, number | null>();
const ORDINALS_KEPT = 100_000;

export function ordinalValue(word: string): number | null {
  const known = ORDINALS.get(word);
  if (known !== undefined) return known;
  if (ORDINALS.size >= ORDINALS_KEPT) ORDINALS.clear();
  const said = word.toLowerCase().replace(/[’ʼ`]/g, "'").replace(/ё/g, "е");
  let found: number | null = null;
  for (const [stem, value] of ORDINAL_STEMS) {
    const ending = said.slice(stem.length);
    if (said.startsWith(stem) && ORDINAL_ENDINGS.has(ending) && (ending.length > 1 || !LONG_ENDING_STEMS.has(stem))) {
      found = value;
      break;
    }
  }
  ORDINALS.set(word, found);
  return found;
}

export function numberValue(text: string): number | null {
  const words = numberTokens(text).map(([word]) => word);
  const index = words.findIndex(isNumeric);
  return index < 0 ? null : cleanNumber(readCardinal(words, index)[0]);
}

// Kopecks after the hryvnia word: with the kopeck word, or a number alone under a hundred («дві гривні сорок», D66); null when none are said.
function kopecksAfter(words: readonly string[]): number | null {
  if (words.some((word) => word.startsWith(KOPECK_PREFIX))) return numberValue(words.join(" ")) || 0;
  const value = words.length && words.every(isNumeric) ? numberValue(words.join(" ")) : null;
  return value !== null && value < KOPECKS_IN_HRYVNIA ? value : null;
}

export function moneyValue(text: string): number | null {
  const words = numberTokens(text).map(([word]) => word);
  const cut = words.findIndex((word) => HRYVNIA_PREFIXES.some((prefix) => word.startsWith(prefix)));
  const kopecks = cut < 0 ? null : kopecksAfter(words.slice(cut + 1));
  if (cut < 0 || kopecks === null) return numberValue(text);
  const hryvnias = numberValue(words.slice(0, cut).join(" ")) || 0;
  return cleanNumber(hryvnias + kopecks / 100);
}

// A percent span: a number with at most percent words («20 відсотків», «двадцять процентов», «20%»); null for anything else (D66, intents v3 §5.1).
export function percentValue(text: string): number | null {
  const words = numberTokens(text).map(([word]) => word);
  return words.every((word) => isNumeric(word) || PERCENT_WORDS.has(word)) ? numberValue(text) : null;
}

function zeroCountAgrees(count: number, word: string): boolean {
  if (count < 2 || (count % 10 === 1 && count % 100 !== 11)) return false;
  const few = [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100);
  return (few ? ZERO_FEW : ZERO_MANY).has(word);
}

function zeroRun(parts: readonly string[], pending: string | undefined, word: string, width: number | null): string[] {
  const count = pending ? Number(pending) : 0;
  const written = parts.filter((part) => part !== FILL).reduce((sum, part) => sum + part.length, 0);
  if (zeroCountAgrees(count, word) && (width === null || written + count <= width)) return [...parts, "0".repeat(count)];
  return [...parts, ...(pending ? [pending] : []), FILL];
}

function filled(parts: readonly string[], width: number | null): string | null {
  const digits = parts.filter((part) => part !== FILL).join("");
  const zeros = width && parts.includes(FILL) ? "0".repeat(Math.max(0, width - digits.length)) : "";
  return parts.map((part) => (part === FILL ? zeros : part)).join("") || null;
}

export function digitString(text: string, width: number | null = null): string | null {
  const words = numberTokens(text).map(([word]) => word);
  if (words.some((word) => classifyNumber(word).kind === "mult")) {
    const value = numberValue(text);
    return value === null ? null : String(Math.trunc(value));
  }
  let parts: string[] = [];
  let group = 0;
  let last: Last = null;
  let afterDigits = false;
  for (const word of words) {
    const { kind, value } = classifyNumber(word);
    if (ZERO_FEW.has(word) || ZERO_MANY.has(word)) {
      const pending = last !== null ? String(Math.trunc(group)) : afterDigits ? parts.pop() : "";
      parts = zeroRun(parts, pending, word, width);
      group = 0;
      last = null;
      afterDigits = false;
      continue;
    }
    if (isFollowKind(kind) && FOLLOWS[kind].has(last)) {
      group += value;
      last = kind;
      continue;
    }
    if (last !== null) {
      parts.push(String(Math.trunc(group)));
      group = 0;
      last = null;
    }
    afterDigits = kind === "digits";
    if (isFollowKind(kind)) {
      group = value;
      last = kind;
    } else if (kind === "digits") {
      parts.push(word.replace(/[^0-9]/g, ""));
    }
  }
  if (last !== null) parts.push(String(Math.trunc(group)));
  return filled(parts, width);
}

export function ibanValue(text: string): string | null {
  const digits = digitString(text, IBAN_DIGITS);
  return digits ? `UA${digits}` : null;
}

// A word that glues digits to letters other than a unit («s24», «8k», «a54») is a model code, not a count: a quantity reads none (D64). «5кг», «2шт», a case
// suffix («2-х») and a «c» or «с» the recogniser glued to the number from the word before («макарон C5 штук» for «макаронс 5 штук»: lh-070, lh-102,
// lh-198, lh-201) still count.
const GLUED_LETTERS: ReadonlySet<string> = new Set(["c", "с"]);

// «сім-карти», «сто-грамовий»: a number word joined by a hyphen to a word that is no number is a word, not a count (D66). «2-х» (digits and a case suffix)
// still counts.
function numberCompound(word: string): boolean {
  const parts = word.toLowerCase().split("-");
  return parts.length > 1 && !/^[0-9]/.test(word) && parts.some((part) => isNumeric(part)) && parts.some((part) => !isNumeric(part));
}

// «три-шість», «два-три», «п'ять-шість», «2-3»: two numbers joined by a hyphen are a range, low and high (D67). A range names a value of a product («3-6»
// місяців, «9-18 кг», `nameTokens.ts`); as a quantity it is no number, and the card asks how many (spec §7 rule 4, `quantity_asks`).
export function numberRange(word: string): readonly [low: number, high: number] | null {
  const parts = word.toLowerCase().replace(/[’ʼ`]/g, "'").split(/[-–]/);
  if (parts.length !== 2 || !parts.every((part) => part !== "" && isNumeric(part))) return null;
  const [low, high] = parts.map((part) => numberValue(part));
  return low === null || high === null || low === undefined || high === undefined ? null : [low, high];
}

// A unit said alone is one of it: a weight, volume or length («кіло печива», «літр молока», «тонну піску»: D66) and, since D67 (the orchestrator's revision
// of D60), a pack or a container («пачку гвоздей», «коробку», «банку», «пляшку», «мішок цементу», «рулон плівки»); since D68 a bucket or a portion («відро»,
// «порцію»).
function singleUnit(span: string): boolean {
  const words = span.trim().toLowerCase().split(/\s+/);
  return words.length === 1 && SPAN_SINGLE_UNITS.has(words[0] ?? "");
}

function modelCode(word: string): boolean {
  if (/^[0-9]+-\p{L}+$/u.test(word)) return false;
  const letters = word.replace(/[0-9.,+]/g, "").toLowerCase();
  return /[0-9]/.test(word) && letters.length > 0 && letters !== word.toLowerCase() && !UNITS.has(letters) && !GLUED_LETTERS.has(letters);
}

// «пол-литра», «пів-кіло»: a half joined to its unit by a hyphen is the half glued to it («поллитра», D71).
export function halvesJoined(text: string): string {
  return text.replace(/(^|\s)(пів|пол)-(?=\p{L})/giu, "$1$2");
}

// «пару штук» is two pieces (D71).
function couplePieces(span: string): boolean {
  const words = span.trim().toLowerCase().split(/\s+/);
  return words.length === 2 && COUPLE_WORDS.has(words[0] ?? "") && COUPLE_PIECES.has(words[1] ?? "");
}

export function valueOf(kind: string, said: unknown): number | string | null {
  if (typeof said !== "string" || !said.trim()) return null;
  const span = halvesJoined(said);
  if (kind === QUANTITY && couplePieces(span)) return COUPLE;
  if (MONEY_KINDS.has(kind)) return moneyValue(span);
  if (kind === QUANTITY && span.split(/\s+/).some((word) => modelCode(word) || numberCompound(word) || numberRange(word) !== null)) return null;
  if (kind === QUANTITY && singleUnit(span)) return 1;
  if (NUMBER_KINDS.has(kind)) return numberValue(span);
  if (kind === PERCENT) return percentValue(span);
  if (DIGIT_KINDS.has(kind)) return digitString(span);
  if (kind === "iban") return ibanValue(span);
  return null;
}

// «останні 7 днів», and since D72 «за 7 днів», «за три дні», «за останні два тижні», «за последние две недели» (a week is seven days).
export function lastDays(text: string): LastDays | null {
  const tokens = numberTokens(text);
  const words = tokens.map(([word]) => word);
  for (let index = 0; index < words.length - 2; index++) {
    const lead = words[index] ?? "";
    if (!LAST_WORDS.has(lead) && !WITHIN_WORDS.has(lead)) continue;
    const at = WITHIN_WORDS.has(lead) && LAST_WORDS.has(words[index + 1] ?? "") ? index + 2 : index + 1;
    if (!isNumeric(words[at] ?? "")) continue;
    const [value, end] = readCardinal(words, at);
    // The span starts at «останні» when it is said (as before D72), else at «за».
    const from = tokens[at - 1];
    const to = tokens[end];
    if (end >= words.length || to === undefined || from === undefined || value < 1 || !Number.isInteger(value)) continue;
    if (DAY_WORDS.has(to[0])) return [value, from[1], to[2]];
    if (WEEK_WORDS.has(to[0])) return [value * DAYS_IN_WEEK, from[1], to[2]];
  }
  return null;
}

const DAYS_IN_WEEK = 7;

const INTEGER_TEXT = /^\s*[+-]?\d+(?:_\d+)*\s*$/;
const DECIMAL_TEXT = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const SMALLEST_PLAIN = 1e-4;

export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function canonicalNumber(value: number): string {
  if (Number.isInteger(value)) return BigInt(value).toString();
  if (value === 0 || Math.abs(value) >= SMALLEST_PLAIN) return String(value);
  return value.toExponential().replace(/e([+-])(\d)$/, (_, sign: string, digit: string) => `e${sign}0${digit}`);
}

export function canonicalOf(kind: string, span: unknown): string | null {
  const value = valueOf(kind, span);
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (MONEY_KINDS.has(kind)) return canonicalNumber(roundHalfEven(value * 100));
  if (kind === "order_number") return `SP-${canonicalNumber(Math.trunc(value)).padStart(4, "0")}`;
  if (kind === "document_ref") return canonicalNumber(Math.trunc(value)).padStart(4, "0");
  return canonicalNumber(value);
}

function integerOf(text: string): number | null {
  return INTEGER_TEXT.test(text) ? Number(text.replace(/_/g, "")) : null;
}

export function valueFromCanonical(kind: string, canonical: string | null): number | string | null {
  if (canonical === null || canonical === "") return null;
  if (MONEY_KINDS.has(kind)) {
    const minor = integerOf(canonical);
    return minor === null ? null : cleanNumber(minor / 100);
  }
  if (kind === "order_number" || kind === "document_ref") {
    const digits = canonical.replace(/[^0-9]/g, "");
    return digits ? Number(digits) : null;
  }
  if (NUMBER_KINDS.has(kind)) return DECIMAL_TEXT.test(canonical) ? cleanNumber(Number(canonical)) : null;
  if (DIGIT_KINDS.has(kind) || kind === "iban") return canonical;
  return null;
}

// D73: «тисячу чотириста тисячу», «три тисячі двісті дві тисячі»: number words that say two sums one after the other (a mixed payment said in words: «чек на
// тисячу чотириста, тисячу карткою …»). A scale word (тисяча, мільйон) that comes again after the number already has one as large is a new number's: it
// starts there when the word says one of it («тисячу», «тысяча»), else at the word before it («дві тисячі»). The indices where a new number starts.
const ONE_SCALE = /^(?:тисяч[аую]|тысяч[аую]|мільйон|миллион)$/;

export function cardinalCuts(words: readonly string[]): number[] {
  const cuts: number[] = [];
  let scale: number | null = null;
  let from = 0;
  for (const [index, word] of words.entries()) {
    const { kind, value } = classifyNumber(word);
    if (kind !== "mult") continue;
    if (scale !== null && value >= scale) {
      const cut = ONE_SCALE.test(word) || index - 1 <= from ? index : index - 1;
      if (cut > from) {
        cuts.push(cut);
        from = cut;
      }
      scale = value;
      continue;
    }
    scale = scale === null ? value : Math.min(scale, value);
  }
  return cuts;
}
