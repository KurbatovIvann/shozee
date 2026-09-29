import type { RecordList, Shop, ShopProduct, ShopRecord } from "./context.ts";
import { LABEL_WORDS, LIST_LABELS } from "./lexicon/catalogue.ts";
import { COUNT_KEY, COUNT_WORDS, PERCENT_SIGNS } from "./lexicon/units.ts";
import { NameIndex } from "./nameIndex.ts";
import { DECIMAL_JOINERS } from "./lexicon/numbers.ts";
import { PART_STOPS, isNumber, nameFit, nameTokens, tokenMatch, type Written } from "./names.ts";
import { canonicalNumber } from "./numbers.ts";
import type { Match } from "./result.ts";

// Lookups of the context's records by what was said (docs/design/sho-api-v2.md §4), built once per compiled context: products by name, alias and brand;
// variants by their attribute values; customers, groups, price lists and counterparties by name and alias. The rules that choose among the hits are in
// `resolve.ts`.

type Via = "name" | "alias";

interface Form {
  readonly owner: number;
  readonly tokens: readonly string[];
  readonly via: Via;
}

// A record the words fit: its index in its list, how, and whether they are one of its names or aliases exactly as written.
export interface Hit {
  readonly index: number;
  readonly match: Match;
  readonly exact: boolean;
}

// Records whose whole name (or alias) fits; those a part of the name fits (D64 `nameFit`); and those whose names and aliases hold every word said, as
// a search finds them («сукня» of «сукня вечірня» and «сукня коктейльна», stop words aside; since D66 the words may come from different names and
// aliases of the record), which only a record's attrs can tell apart (§4.1 rule 4).
export interface Hits {
  readonly whole: readonly Hit[];
  readonly part: readonly Hit[];
  readonly named: readonly Hit[];
}

// The thread and rim letters as `nameTokens` writes them («M8x40» → «m», «8», «40»; «R17» → «r», «17»).
const THREAD = "m";
const RIM = "r";
const MILLIMETRES = "mm";
// Words that say what a value is, left out of an attr that names no value with them: the labels, and «номер» («номер тридцять вісім», D71).
const VALUE_LABELS: ReadonlySet<string> = new Set([...LABEL_WORDS, "номер", "номера", "номеру", "номером", "номері"]);

const RANK: Readonly<Record<Match, number>> = { exact: 0, form: 1, sound: 2, alias: 3, part: 4, attrs: 5, only: 6 };
const NO_HITS: Hits = { whole: [], part: [], named: [] };

function wholeMatch(spoken: readonly string[], form: Form, proper: boolean): Match {
  if (form.via === "alias") return "alias";
  if (spoken.join(" ") === form.tokens.join(" ")) return "exact";
  return spoken.length === form.tokens.length && spoken.some((token, index) => tokenMatch(token, form.tokens[index] ?? "", { proper }) === "sound") ? "sound" : "form";
}

function best(hits: Map<number, Hit>, owner: number, match: Match, exact = false): void {
  const known = hits.get(owner);
  const kept = known === undefined || RANK[match] < RANK[known.match] ? match : known.match;
  hits.set(owner, { index: owner, match: kept, exact: exact || known?.exact === true });
}

function sorted(hits: ReadonlyMap<number, Hit>): Hit[] {
  return [...hits.values()].sort((left, right) => left.index - right.index);
}

// The words of all of a record's names and aliases, each with whether an alias gave it: a search for every word said looks in all of them at once
// («картошки молодой» of «Картопля молода» with the alias «картошка», D66).
type Words = readonly (readonly [token: string, alias: boolean])[];

function recordWords(forms: readonly Form[], owners: number): Words[] {
  const words: [string, boolean][][] = Array.from({ length: owners }, () => []);
  for (const form of forms) {
    const own = words[form.owner];
    for (const token of form.tokens) if (own !== undefined && !own.some(([known]) => known === token)) own.push([token, form.via === "alias"]);
  }
  return words;
}

// Names and aliases of one list, each record's forms under one token index, and each record's words under another. `proper`: the records are named as
// people are (customers, groups, price lists, counterparties), so their words match as names do (D66).
class Forms {
  private readonly forms: readonly Form[];
  private readonly index: NameIndex;
  private readonly words: readonly Words[];
  private readonly proper: boolean;

  constructor(owners: readonly (readonly [names: readonly string[], aliases: readonly string[]])[], proper = false) {
    this.proper = proper;
    this.forms = owners.flatMap(([names, aliases], owner) => [
      ...names.map((name): Form => ({ owner, tokens: nameTokens(name), via: "name" })),
      ...aliases.map((alias): Form => ({ owner, tokens: nameTokens(alias), via: "alias" })),
    ]).filter((form) => form.tokens.length > 0);
    this.index = new NameIndex(
      this.forms.map((form) => form.tokens),
      new Set(this.forms.flatMap((form, index) => (form.via === "alias" ? [index] : []))),
    );
    this.words = recordWords(this.forms, owners.length);
  }

  // The records each word said may match a word of, through the forms' index: the records every word reaches are searched.
  private reachedByAll(words: readonly string[]): number[] {
    let kept: Set<number> | null = null;
    for (const forms of this.index.reaching(words)) {
      const owners = new Set<number>();
      for (const at of forms) {
        const owner = this.forms[at]?.owner;
        if (owner !== undefined && (kept === null || kept.has(owner))) owners.add(owner);
      }
      kept = owners;
      if (!kept.size) break;
    }
    return [...(kept ?? [])].sort((left, right) => left - right);
  }

  // The records whose names and aliases hold every word said, stop words aside (a search).
  private searched(words: readonly string[]): number[] {
    if (!words.length) return [];
    return this.reachedByAll(words).filter((owner) => {
      const own = this.words[owner] ?? [];
      return words.every((token) => own.some(([known, alias]) => tokenMatch(token, known, { alias, proper: this.proper }) !== null));
    });
  }

  hits(spoken: readonly string[]): Hits {
    if (!spoken.length) return NO_HITS;
    const whole = new Map<number, Hit>();
    const part = new Map<number, Hit>();
    const named = new Map<number, Hit>();
    const words = spoken.filter((token) => !PART_STOPS.has(token));
    for (const at of this.index.candidates(spoken)) {
      const form = this.forms[at];
      if (form === undefined) continue;
      const written: Written = { alias: form.via === "alias", proper: this.proper };
      const fit = nameFit(spoken, form.tokens, written);
      if (fit === "whole") best(whole, form.owner, wholeMatch(spoken, form, this.proper), spoken.join(" ") === form.tokens.join(" "));
      else if (fit === "part") best(part, form.owner, "part");
    }
    for (const owner of this.searched(words)) if (!whole.has(owner) && !part.has(owner)) best(named, owner, "part");
    return { whole: sorted(whole), part: sorted(part), named: sorted(named) };
  }
}

// A product named with its brand is also named without it («Nike Air Max 90», «кросівки Nike Terra» with brand «Nike» are «Air Max 90», «кросівки
// Terra»), one named without it also with it in front («Air Max 90» is «Nike Air Max 90»), and the brand alone names each of the brand's products (§2.1).
export function brandForms(name: string, brand: string | null): string[] {
  if (brand === null) return [];
  const words = name.split(/\s+/).filter(Boolean);
  const own = brand.toLowerCase().split(/\s+/).filter(Boolean);
  const at = words.findIndex((_, start) => own.every((word, offset) => words[start + offset]?.toLowerCase() === word));
  if (at < 0) return [`${brand} ${name}`, brand];
  const without = [...words.slice(0, at), ...words.slice(at + own.length)].join(" ");
  return without ? [without, brand] : [brand];
}

// «SteelSeries» is said as one word or two («стил сериес», D71): a Latin word written in two capitals is also named by its parts, when each part has five
// letters or more («PowerGear» is not: «Gear», «Power» alone sound like common words, «пари»).
const CAMEL_WORD = /[A-Z][a-z]+(?:[A-Z][a-z]+)+/g;
const CAMEL_PART = /[A-Z][a-z]*/g;
const SHORTEST_PART = 5;

function apart(name: string): string {
  return name.replace(CAMEL_WORD, (word) => {
    const parts = word.match(CAMEL_PART) ?? [word];
    return parts.every((part) => part.length >= SHORTEST_PART) ? parts.join(" ") : word;
  });
}

function withParts(names: readonly string[]): string[] {
  return [...new Set(names.flatMap((name) => {
    const split = apart(name);
    return split === name ? [name] : [name, split];
  }))];
}

// The names a product is said by in full: its name and the name with or without its brand, and a brand word in two capitals by its parts (D71).
export function fullNames(product: ShopProduct): string[] {
  return withParts([product.name, ...brandForms(product.name, product.brand).slice(0, -1)]);
}

// Its full names and its brand alone, which names each product of the brand.
export function productNames(product: ShopProduct): string[] {
  return withParts([product.name, ...brandForms(product.name, product.brand)]);
}

// A value said as a bare number fits a value that is that number with a unit («256» of «256 ГБ», «50» of «50 мл»): a number with or without its unit (§4.1).
function numberFit(spoken: readonly string[], value: readonly string[]): boolean {
  return spoken.length === 1 && value.length === 2 && isNumber(spoken[0] ?? "") && spoken[0] === value[0];
}

// A size said without its letter (D71): a metric thread «M8x40» said «вісім на сорок» (or «… міліметрів»), a rim «R17» said «сімнадцять» or «сімнадцяті».
function letterlessFit(spoken: readonly string[], value: readonly string[]): boolean {
  const [letter, ...numbers] = value;
  const said = letter === THREAD && spoken.at(-1) === MILLIMETRES ? spoken.slice(0, -1) : spoken;
  // A thread needs its length too: «вісім» alone is no «M8» (a count, or another value in millimetres).
  const least = letter === THREAD ? 2 : 1;
  return (letter === THREAD || letter === RIM) && numbers.length >= least && numbers.length === said.length && numbers.every((token, index) => isNumber(token) && said[index] === token);
}

function valueFits(spoken: readonly string[], value: readonly string[]): "whole" | "part" | null {
  if (numberFit(spoken, value) || letterlessFit(spoken, value)) return "whole";
  return nameFit(spoken, value);
}

// D82: the ending of an ordinal written with digits («40-й», «42-го»): the size is the number.
const ORDINAL_ENDINGS: ReadonlySet<string> = new Set(["й", "го", "ий", "ій", "ого", "ому", "му", "ої", "ой", "ая", "ое"]);

// A value's tokens as an attr is compared with them (D71): a count word after a number is «шт» («9 шт» said «дев'ять штук»), a percent word after a number
// goes («20%» said «двадцять відсотків»; the «%» is no token); D82: so does an ordinal's ending («40-й» is 40).
function valueTokens(tokens: readonly string[]): string[] {
  return tokens.flatMap((token, at) => {
    if (at === 0 || !isNumber(tokens[at - 1] ?? "")) return [token];
    if (COUNT_WORDS.has(token)) return [COUNT_KEY];
    return PERCENT_SIGNS.has(token) || ORDINAL_ENDINGS.has(token) ? [] : [token];
  });
}

const WHOLE_NUMBER = /^[0-9]+$/;
const DENOMINATORS: ReadonlySet<string> = new Set(["10", "100", "1000"]);

// D79: a decimal said in words, as the tokens read it: «тринадцять і п'ять мілілітрів» (13, «і», 5, ml) is 13.5 ml, «одна ціла дві десятих» (1, «ціла»,
// 2, 10) 1.2, «нуль п'ять» (0, 5) 0.5, «два кома п'ять» 2.5: the tokens with the first such number read as one, null when there is none. The whole part
// is followed by a joiner («і», «кома», «ціла»; none after a zero) and a whole number, and maybe by its denominator (10, 100, 1000; else the number's
// own digits say it). Only a variant's value is read so (`ProductValues.matching`, when the tokens as said fit none): «2 і 5» is two numbers elsewhere.
export function decimalTokens(tokens: readonly string[]): string[] | null {
  for (let at = 0; at < tokens.length; at++) {
    const whole = tokens[at] ?? "";
    if (!WHOLE_NUMBER.test(whole)) continue;
    const joined = DECIMAL_JOINERS.has(tokens[at + 1] ?? "");
    const from = joined ? at + 2 : at + 1;
    const part = tokens[from] ?? "";
    if ((!joined && whole !== "0") || !WHOLE_NUMBER.test(part) || Number(part) === 0) continue;
    const denominator = tokens[from + 1] ?? "";
    const over = DENOMINATORS.has(denominator) && Number(part) < Number(denominator);
    const value = Number(whole) + Number(part) / (over ? Number(denominator) : 10 ** part.length);
    return [...tokens.slice(0, at), canonicalNumber(Number(value.toFixed(6))), ...tokens.slice(from + (over ? 2 : 1))];
  }
  return null;
}

// The attribute values of one product's variants.
export class ProductValues {
  private readonly values: readonly (readonly (readonly string[])[])[];

  constructor(product: ShopProduct) {
    this.values = (product.variants ?? []).map((variant) => [...variant.values, ...variant.aliases].map((value) => valueTokens(nameTokens(value))).filter((tokens) => tokens.length > 0));
  }

  // The variants (indices) an attr names: a value or alias it fits whole, or, when it fits none whole, the one value a part of it fits (§4.1); when it
  // names none, the attr without the words that label a value («номер тридцять вісім», «сорок третього розміру», D71).
  // D79: when the words as said fit none, a decimal said in words (`decimalTokens`).
  matching(attr: string): number[] {
    const spoken = valueTokens(nameTokens(attr));
    const found = this.matchingTokens(spoken);
    const unlabelled = spoken.filter((token) => !VALUE_LABELS.has(token));
    const plain = found.length || unlabelled.length === spoken.length ? found : this.matchingTokens(unlabelled);
    const decimal = plain.length ? null : decimalTokens(unlabelled);
    return decimal === null ? plain : this.matchingTokens(decimal);
  }

  private matchingTokens(spoken: readonly string[]): number[] {
    if (!spoken.length) return [];
    const whole = this.values.flatMap((values, index) => (values.some((value) => valueFits(spoken, value) === "whole") ? [index] : []));
    if (whole.length) return whole;
    const parts = new Map<string, number[]>();
    for (const [index, values] of this.values.entries()) {
      for (const value of values) {
        if (valueFits(spoken, value) !== "part") continue;
        const key = value.join(" ");
        parts.set(key, [...(parts.get(key) ?? []), index]);
      }
    }
    const [only] = parts.values();
    return parts.size === 1 && only !== undefined ? [...new Set(only)] : [];
  }
}

function spokenOf(text: string, labels: ReadonlySet<string> = new Set()): string[] {
  return nameTokens(text).filter((token) => !labels.has(token));
}

// One list of named records (customers, groups, price lists, counterparties).
export class RecordIndex {
  readonly records: readonly ShopRecord[];
  private readonly forms: Forms;
  private readonly byText = new Map<string, number[]>();

  constructor(records: readonly ShopRecord[]) {
    this.records = records;
    this.forms = new Forms(
      records.map((record) => [[record.name], record.aliases]),
      true,
    );
    for (const [index, record] of records.entries()) {
      for (const text of [record.name, ...record.aliases]) {
        const found = this.byText.get(text);
        if (found === undefined) this.byText.set(text, [index]);
        else if (!found.includes(index)) found.push(index);
      }
    }
  }

  // Every name and alias, for the customer matcher (`customers.ts` `NameList`).
  names(): string[] {
    return [...this.byText.keys()];
  }

  // The records a name or alias, as written, belongs to.
  named(text: string): readonly number[] {
    return this.byText.get(text) ?? [];
  }

  hits(text: string): Hits {
    return this.forms.hits(spokenOf(text, LIST_LABELS));
  }
}

export class Records {
  readonly shop: Shop;
  readonly lists: Readonly<Record<RecordList, RecordIndex | null>>;
  private readonly productForms: Forms | null;
  private readonly values = new Map<number, ProductValues>();

  constructor(shop: Shop) {
    this.shop = shop;
    const products = shop.products;
    this.productForms = products === null ? null : new Forms(products.map((product) => [productNames(product), product.aliases]));
    const list = (name: RecordList): RecordIndex | null => {
      const records = shop.lists[name];
      return records === null ? null : new RecordIndex(records);
    };
    this.lists = { customers: list("customers"), groups: list("groups"), priceLists: list("priceLists"), counterparties: list("counterparties") };
  }

  products(text: string): Hits {
    return this.productForms?.hits(spokenOf(text)) ?? NO_HITS;
  }

  product(index: number): ShopProduct | null {
    return this.shop.products?.[index] ?? null;
  }

  valuesOf(index: number): ProductValues | null {
    const product = this.product(index);
    if (product === null) return null;
    const known = this.values.get(index);
    if (known !== undefined) return known;
    const built = new ProductValues(product);
    this.values.set(index, built);
    return built;
  }
}
