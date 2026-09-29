import { ADDRESS_STOPS, BANK_PHRASES, BANK_STEMS, BRANCH_STEMS, CARGO_STEMS, CITIES, CURRENCY_STEMS, EMAIL_WORDS, FLAT_WORDS, HOUSE_LETTERS, HOUSE_WORDS, POSTOMAT_CM, POSTOMAT_GRAMS, STREET_WORDS, THOUSAND, THOUSAND_WORDS, type BranchKind, type Currency } from "./lexicon/values.ts";
import { METHOD_STEMS, type PaymentMethodKey } from "./lexicon/roles.ts";
import { Dates } from "./dates.ts";
import { sameWord } from "./morphology.ts";
import { nameTokens } from "./nameTokens.ts";
import { digitString, moneyValue, numberTokens, numberValue, numberWordKind, percentValue } from "./numbers.ts";
import { BY_WORDS, UNIT_KEYS } from "./lexicon/units.ts";
import type { TaggedSpan } from "./spans.ts";
import { parseWhen, type Now, type When } from "./when.ts";

// The v3 value readers (intents v3 §5.1, D69): the model tags a span by its type, and the runtime reads the span into a canonical value. Each reader
// takes the span as said and gives null when the span says no such value; the command builder (`command.ts`) turns a null into an `invalid_value` need.

export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

// A ТТН: 14 digits are a Nova Poshta waybill, 13 digits from «05» an Ukrposhta barcode, 3 to 5 digits the end of one the host matches («посилка на 8223»).
export interface Ttn {
  readonly digits: string;
  readonly partial: boolean;
  readonly carrier?: "nova_poshta" | "ukrposhta";
}

export interface Branch {
  readonly kind: BranchKind;
  readonly number: number | null;
}

// A weight in grams or the sides of a parcel in centimetres.
export type MeasureValue = { readonly grams: number } | { readonly cm: readonly number[] };

// A city as said and, when the list knows it, its Ukrainian nominative; the host resolves it against Nova Poshta's settlements.
export interface City {
  readonly name: string | null;
}

// A delivery address split lightly (D70): the street as said, the house and the flat; the host geocodes it.
export interface Address {
  readonly street: string | null;
  readonly house: string | null;
  readonly apt: string | null;
}

export type V3Value = Money | Ttn | Branch | MeasureValue | City | When | Address | number | string;

const NP_DIGITS = 14;
const UKRPOSHTA_DIGITS = 13;
const PARTIAL_DIGITS: readonly [number, number] = [3, 5];
const MINOR = 100;
const PERCENT_MAX = 100;
const GRAMS: Readonly<Record<string, number>> = { g: 1, kg: 1000, t: 1_000_000 };
const CENTIMETRES: Readonly<Record<string, number>> = { mm: 0.1, cm: 1, m: 100 };
const NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;
const DATES = new Dates();
const HALF_JOINS: ReadonlySet<string> = new Set(["з", "с", "із"]);
const HALF_WORDS: ReadonlySet<string> = new Set(["половиною", "половиной"]);

function folded(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[’ʼ`]/g, "'");
}

function wordsOf(text: string): string[] {
  return folded(text).split(/[\s,.;:!?«»"()]+/).filter(Boolean);
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// «дві з половиною тисячі»: the half belongs to the thousands (2500), not to the two (`readCardinal` stops at «з половиною»).
function halvedThousands(words: readonly string[]): string[] {
  const at = words.findIndex((word, index) => HALF_JOINS.has(word) && HALF_WORDS.has(words[index + 1] ?? "") && index > 0);
  const before = at < 0 ? null : numberValue(words.slice(0, at).join(" "));
  const after = words[at + 2] ?? "";
  if (at < 0 || before === null || !(THOUSAND_WORDS.has(after) || after.startsWith("тисяч") || after.startsWith("тысяч"))) return [...words];
  return [String(before + 0.5), THOUSAND, ...words.slice(at + 3)];
}

// «півтори тисячі» 1500 грн, «1,5к», «1,5 тис», «полторы тыщи», «два косаря» 2000, «870 гривень 50 копійок», «50 баксів» 50 USD (intents v3 §5.1).
export function moneyAmount(text: string): Money | null {
  const words = halvedThousands(numberTokens(text).map(([word]) => word));
  const said = words.map((word, index) => (index > 0 && THOUSAND_WORDS.has(word) && numberValue(words[index - 1] ?? "") !== null ? THOUSAND : word));
  const value = moneyValue(said.join(" "));
  if (value === null || !Number.isFinite(value)) return null;
  const lowered = folded(text);
  const currency = CURRENCY_STEMS.find(([stem]) => (stem.length === 1 ? lowered.includes(stem) : wordsOf(text).some((word) => word.startsWith(stem))))?.[1] ?? "UAH";
  return { minor: Math.round(value * MINOR), currency };
}

export function countValue(text: string): number | null {
  const value = numberValue(text);
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null;
}

// A percent up to 100 («10 відсотків», «15%»); more than 100 is no percent (the card asks).
export function percentAmount(text: string): number | null {
  const value = percentValue(text);
  return value !== null && value >= 0 && value <= PERCENT_MAX ? value : null;
}

export function ttnValue(text: string): Ttn | null {
  const digits = digitString(text);
  if (digits === null) return null;
  if (digits.length === NP_DIGITS) return { digits, partial: false, carrier: "nova_poshta" };
  if (digits.length === UKRPOSHTA_DIGITS && digits.startsWith("05")) return { digits, partial: false, carrier: "ukrposhta" };
  if (digits.length >= PARTIAL_DIGITS[0] && digits.length <= PARTIAL_DIGITS[1]) return { digits, partial: true };
  return null;
}

// «третє відділення», «відділення 7», «поштомат 2231», «пункт видачі 5»: the kind from the head word, the number in digits, words or an ordinal; «склад
// 14» is a branch, «вантажне відділення 1» a cargo branch (D71).
export function branchValue(text: string): Branch | null {
  const words = wordsOf(text);
  const said = words.flatMap((word) => BRANCH_STEMS.filter(([stem]) => word.startsWith(stem)).map(([, found]) => found))[0];
  const cargo = words.some((word) => CARGO_STEMS.some((stem) => word.startsWith(stem)));
  const kind = said === "branch" && cargo ? "cargo" : said;
  const rest = words.filter((word) => !BRANCH_STEMS.some(([stem]) => word.startsWith(stem)) && !CARGO_STEMS.some((stem) => word.startsWith(stem)));
  const ordinal = rest.some((word) => !/^[0-9]+$/.test(word) && DATES.ordinal(word) !== null) ? (DATES.tokens(rest.join(" ")).find(([found]) => found === "day")?.[1] ?? null) : null;
  const cardinal = numberValue(rest.join(" "));
  const number = ordinal ?? (cardinal !== null && Number.isInteger(cardinal) ? cardinal : null);
  if (kind === undefined && number === null) return null;
  return { kind: kind ?? "branch", number };
}

function numberWord(word: string): boolean {
  return numberWordKind(word) !== null;
}

// D73: «кілограми два» is «два кілограми»: a unit said before the number only.
function unitFirst(text: string): string {
  const [unit, ...rest] = wordsOf(text);
  return unit !== undefined && UNIT_KEYS.has(unit) && rest.length > 0 && rest.every(numberWord) ? `${rest.join(" ")} ${unit}` : text;
}

// «два кіла» 2000 g, «півтора кіла» 1500 g, «30 на 20 на 10» [30, 20, 10] cm, «0,3 на 0,2 метра» [30, 20] cm; D73: «кілограми два» 2000 g.
export function measureValue(said: string): MeasureValue | null {
  const text = unitFirst(said);
  const tokens = nameTokens(text);
  for (let at = 0; at + 1 < tokens.length; at++) {
    const scale = GRAMS[tokens[at + 1] ?? ""];
    const number = tokens[at] ?? "";
    if (scale !== undefined && NUMBER.test(number)) return { grams: rounded(Number(number) * scale) };
  }
  const numbers = tokens.filter((token) => NUMBER.test(token)).map(Number);
  if (numbers.length < 2 || numbers.length > 3) return null;
  const unit = tokens.find((token) => Object.hasOwn(CENTIMETRES, token));
  const scale = unit === undefined ? 1 : (CENTIMETRES[unit] ?? 1);
  return { cm: numbers.map((number) => rounded(number * scale)) };
}

// Does a measure fit a parcel locker (≤ 20 kg, 40 × 30 × 60 cm)?
export function fitsPostomat(measure: MeasureValue): boolean {
  if ("grams" in measure) return measure.grams <= POSTOMAT_GRAMS;
  const sides = measure.cm.toSorted((left, right) => right - left);
  return sides.every((side, index) => side <= (POSTOMAT_CM[index] ?? Number.POSITIVE_INFINITY));
}

interface CityForm {
  readonly words: readonly string[];
  readonly name: string;
}

function accusative(nominative: string): string | null {
  if (nominative.includes(" ")) return null;
  if (nominative.endsWith("я")) return `${nominative.slice(0, -1)}ю`;
  if (nominative.endsWith("а")) return `${nominative.slice(0, -1)}у`;
  return null;
}

const CITY_FORMS: readonly CityForm[] = CITIES.flatMap((forms) => {
  const name = forms[0] ?? "";
  const all = [...forms, ...[forms[0], forms[3]].flatMap((form) => (form === undefined ? [] : [accusative(form) ?? []].flat()))];
  return [...new Set(all.map(folded))].map((form) => ({ words: form.split(" "), name }));
});

// The city a span names: a form of a listed city («у Вінницю», «в Броварах», «Кривого Рогу», ru «в Харьков»), else a word form of one (the paradigm
// matcher, `sameWord`); `name` null for a town the list does not know (the host searches Nova Poshta's settlements).
export function cityValue(text: string): City {
  const words = wordsOf(text);
  const exact = CITY_FORMS.find((form) => form.words.length === words.length && form.words.every((word, index) => word === words[index]));
  if (exact !== undefined) return { name: exact.name };
  const tail = CITY_FORMS.find((form) => form.words.length <= words.length && form.words.every((word, index) => word === words[words.length - form.words.length + index]));
  if (tail !== undefined) return { name: tail.name };
  const near = words.length === 1 ? CITY_FORMS.find((form) => form.words.length === 1 && sameWord(words[0] ?? "", form.words[0] ?? "")) : undefined;
  return { name: near?.name ?? null };
}

// The bank or payment provider a span names («моно», «в приваті», «пумб»), by its canonical key; null for one the lexicon does not know.
export function bankValue(text: string): string | null {
  const lowered = wordsOf(text).join(" ");
  const phrase = BANK_PHRASES.find(([words]) => ` ${lowered} `.includes(` ${words} `));
  if (phrase !== undefined) return phrase[1];
  for (const word of wordsOf(text)) {
    const found = BANK_STEMS.find(([stem]) => word.startsWith(stem));
    if (found !== undefined) return found[1];
  }
  return null;
}

// «oksana.shop собака gmail крапка com» → «oksana.shop@gmail.com»; null for anything that is no address.
export function emailValue(text: string): string | null {
  const parts = folded(text).split(/\s+/).filter(Boolean).map((word) => EMAIL_WORDS.get(word) ?? word);
  const address = parts.join("");
  return EMAIL.test(address) ? address : null;
}

// `parseWhen`, and a date said with «за» for the day a record is for («запиши дохід за вчора», «за понеділок», intents v3 §4.5 `on`). `past` (D72): the
// span says when a past event happened, so a weekday or a date is the latest one up to today.
export function whenValue(text: string, now: Now, past = false): When | null {
  const read = parseWhen(text, now, past);
  if (read !== null) return read;
  const words = folded(text).split(/\s+/).filter(Boolean);
  return words[0] === "за" && words.length > 1 ? parseWhen(words.slice(1).join(" "), now, past) : null;
}

// «вулиця шевченка 12 квартира 5» {street: «шевченка», house: «12», apt: «5»}; «хрещатик 1 кв 7»; «проспект перемоги 45 а»; «шевченка 12 1» (from
// «12/1») house «12/1»; numbers said in words are read («сорок п'ять»). Never null: a span with no number is all street (D70).
export function addressValue(text: string): Address {
  const words = folded(text).split(/\s+/).filter(Boolean);
  const stop = words.findIndex((word) => ADDRESS_STOPS.has(word));
  const said = stop < 0 ? words : words.slice(0, stop);
  const flatAt = said.findIndex((word) => FLAT_WORDS.has(word));
  const main = flatAt < 0 ? said : said.slice(0, flatAt);
  const apt = flatAt < 0 ? null : numberOf(leadingNumbers(said.slice(flatAt + 1)));
  const houseAt = main.findIndex((word, index) => index > 0 && HOUSE_WORDS.has(word));
  const numbers = houseAt < 0 ? trailingNumbers(main) : leadingNumbers(main.slice(houseAt + 1));
  const streetWords = (houseAt < 0 ? main.slice(0, main.length - numbers.length) : main.slice(0, houseAt)).filter((word) => !STREET_WORDS.has(word));
  return { street: streetWords.length ? streetWords.join(" ") : null, house: numberOf(numbers), apt };
}

function numeric(word: string): boolean {
  return /^[0-9]+\p{L}?$/u.test(word) || numberValue(word) !== null;
}

function leadingNumbers(words: readonly string[]): string[] {
  const found: string[] = [];
  for (const word of words) {
    if (numeric(word) || (found.length > 0 && /^[0-9]+$/.test(found.at(-1) ?? "") && HOUSE_LETTERS.has(word))) found.push(word);
    else break;
  }
  return found;
}

function trailingNumbers(words: readonly string[]): string[] {
  let from = words.length;
  if (from > 1 && HOUSE_LETTERS.has(words[from - 1] ?? "") && /^[0-9]+$/.test(words[from - 2] ?? "")) from -= 1;
  while (from > 1 && numeric(words[from - 1] ?? "")) from -= 1;
  return words.slice(from);
}

// A house or flat number: digits with a letter («45а»), two digit groups as a building («12/1»), or a number said in words.
function numberOf(words: readonly string[]): string | null {
  if (!words.length) return null;
  const letter = words.length > 1 && HOUSE_LETTERS.has(words.at(-1) ?? "") ? (words.at(-1) ?? "") : "";
  const parts = letter ? words.slice(0, -1) : words;
  if (parts.every((word) => /^[0-9]+\p{L}?$/u.test(word))) return `${parts.join("/")}${letter}`;
  const value = numberValue(parts.join(" "));
  return value === null ? parts.join(" ") : `${value}${letter}`;
}

// An IBAN is «UA», two check digits and 25 more; the ISO 7064 mod-97 check catches a digit the recogniser misheard (intents v3 §5.1, D70).
export function ibanValid(iban: string): boolean {
  if (!/^UA[0-9]{27}$/.test(iban)) return false;
  const moved = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of moved) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

const EDRPOU_WEIGHTS = [1, 2, 3, 4, 5, 6, 7];
const EDRPOU_SHIFTED = [7, 1, 2, 3, 4, 5, 6];
const EDRPOU_LOW = 30_000_000;
const EDRPOU_HIGH = 60_000_000;
const RNOKPP_WEIGHTS = [-1, 5, 7, 9, 4, 6, 10, 5, 7];

function weighted(digits: readonly number[], weights: readonly number[]): number {
  return weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0);
}

// ЄДРПОУ (8 digits): weights 1–7 (7, 1–6 for codes from 30,000,000 to 60,000,000), sum mod 11; a 10 is retried with every weight + 2, and a second 10
// is 0. РНОКПП (10 digits): weights −1, 5, 7, 9, 4, 6, 10, 5, 7, sum mod 11, 10 as 0. Another length is no code (D70).
export function taxIdValid(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  const said = [...digits].map(Number);
  if (digits.length === 10) return ((weighted(said, RNOKPP_WEIGHTS) % 11) + 11) % 11 % 10 === said[9];
  if (digits.length !== 8) return false;
  const code = Number(digits);
  const weights = code < EDRPOU_LOW || code > EDRPOU_HIGH ? EDRPOU_WEIGHTS : EDRPOU_SHIFTED;
  let check = weighted(said, weights) % 11;
  if (check === 10) check = weighted(said, weights.map((weight) => weight + 2)) % 11 % 10;
  return check === said[7];
}

// The payment method a word names («готівкою», «карткою», «безнал»), or null.
export function methodOf(word: string): PaymentMethodKey | null {
  const lowered = folded(word);
  return METHOD_STEMS.find(([stem]) => lowered.startsWith(stem))?.[1] ?? null;
}

// D73: the measures of a v3 measure list as said, not only as tagged: a measure span that says no number («кілограми»), reads no measure («сто» of
// «сто сорок на вісімдесят на двадцять», whose other words the model tagged apart) or starts with «на» / «x» (after the number it needs) is read with the
// number before it and the words after it that are numbers, «на» / «x» or units,
// so «кілограми два» is 2 kg and «коробка сто сорок на вісімдесят на двадцять» one box of 140 × 80 × 20 cm; the spans that run takes are part of it.
export function measureTexts(utterance: string, spans: readonly TaggedSpan[], kind: string): string[] {
  const own = spans.filter((span) => span.kind === kind).toSorted((left, right) => left.start - right.start);
  const words = Array.from(utterance.matchAll(/\S+/g), (match) => [match[0], match.index, match.index + match[0].length] as const);
  const texts: string[] = [];
  let covered = -1;
  for (const span of own) {
    if (span.start < covered) continue;
    const read = measureValue(span.text);
    if (read !== null && wordsOf(span.text).some(numberWord) && !BY_WORDS.has(wordsOf(span.text)[0] ?? "")) {
      if (!texts.includes(span.text)) texts.push(span.text);
      continue;
    }
    let first = words.findIndex(([, start]) => start >= span.start);
    // «тридцять | на двадцять на десять»: the number said before a span that starts with «на» is its first side.
    while (first > 0 && numberWord(words[first - 1]?.[0] ?? "") && (words[first - 1]?.[1] ?? 0) > covered && BY_WORDS.has(words[first]?.[0] ?? "")) first -= 1;
    let last = first;
    while (last < words.length) {
      const word = words[last]?.[0] ?? "";
      if (!numberWord(word) && !BY_WORDS.has(word) && !UNIT_KEYS.has(word)) break;
      last += 1;
    }
    while (last > first && BY_WORDS.has(words[last - 1]?.[0] ?? "")) last -= 1;
    const run = first < 0 ? "" : utterance.slice(words[first]?.[1] ?? 0, words[last - 1]?.[2] ?? 0);
    const grown = run && wordsOf(run).some(numberWord) && measureValue(run) !== null;
    const text = grown ? run : span.text;
    if (grown) covered = words[last - 1]?.[2] ?? covered;
    if (!texts.includes(text)) texts.push(text);
  }
  return texts;
}
