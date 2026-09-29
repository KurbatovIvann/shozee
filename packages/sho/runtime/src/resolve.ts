import type { ShopProduct, ShopRecord } from "./context.ts";
import { COUPLE_WORDS } from "./lexicon/numbers.ts";
import { COUNTING_UNITS, HALF_GLUED, PIECE_CONTAINERS, QUANTITY_UNIT_KEYS, UNITS, UNIT_SCALES, type SaleUnit } from "./lexicon/units.ts";
import type { OrderLine } from "./lines.ts";
import { nameMatch, nameWords, type NameList } from "./nameList.ts";
import { isNumber, nameTokens, tokenMatch } from "./names.ts";
import { cleanNumber, digitString, halvesJoined, numberWordKind, valueOf } from "./numbers.ts";
import { adjectiveLike, lettersOnly } from "./words.ts";
import { DECIMAL_JOINERS } from "./lexicon/numbers.ts";
import type { Hit, Hits, ProductValues, RecordIndex, Records } from "./records.ts";
import type { Attr, Candidate, Match, NeedReason, OrderItem, Quantity, Ref, VariantRef } from "./result.ts";

// The resolution rules of docs/design/sho-api-v2.md §4 (D65): a product span against the products, its attribute words as a set against that product's
// variants, the numbers between attrs and quantity, the spoken unit against the product's, and names against the other lists.

// A need of one param, its path relative to the param («variant», «attrs[1]»).
export interface ParamNeed {
  readonly path: string;
  readonly reason: NeedReason;
  readonly blocking: boolean;
}

export interface Outcome<T> {
  readonly value: T;
  readonly needs: readonly ParamNeed[];
}

// What a lookup knows: the records and the customer names (null without a context), and whether the command restores a record: an archived record is
// never in the context, so a restore's record that is not found is left to the host (§3.6).
export interface Lookup {
  readonly records: Records | null;
  readonly customers: NameList | null;
  readonly restoring: boolean;
  // D79: the command's words, where two attrs said as one decimal are looked up with the word between them (`decimalJoined`).
  readonly text?: string;
}

// The confidence of the model span a text came from (`command.ts`), undefined when no span holds it.
export type Confidences = (text: string) => number | undefined;

type Listed = { readonly candidates: readonly Candidate[]; readonly truncated?: true };

export const MOST_CANDIDATES = 20;
// A ref said as at least this many digits is a phone or an ЄДРПОУ: those never go to the device (§2.1, owner's answer to Q4), so the host resolves it.
const NUMBER_DIGITS = 7;
const DIGITS = /^[+\d()-]+$/;
const NO_CONFIDENCE: Confidences = () => undefined;

function blocking(path: string, reason: NeedReason): ParamNeed {
  return { path, reason, blocking: true };
}

function scored<T extends object>(value: T, confidence: number | undefined): T {
  return confidence === undefined ? value : { ...value, confidence };
}

function listed(candidates: readonly Candidate[]): Listed {
  return candidates.length > MOST_CANDIDATES ? { candidates: candidates.slice(0, MOST_CANDIDATES), truncated: true } : { candidates };
}

function picked<T>(items: readonly T[], indices: readonly number[]): T[] {
  return indices.flatMap((index) => {
    const item = items[index];
    return item === undefined ? [] : [item];
  });
}

function saidByNumber(text: string): boolean {
  const digits = digitString(text);
  return digits !== null && digits.length >= NUMBER_DIGITS && text.split(/\s+/).every((word) => DIGITS.test(word) || valueOf("quantity", word) !== null);
}

// Nothing fits: unknown when the whole list was checked, else the host resolves the text.
function missed(text: string, checked: boolean, lookup: Lookup): Ref {
  return { text, status: checked && !lookup.restoring && !saidByNumber(text) ? "unknown" : "unchecked" };
}

function recordCandidate(record: ShopRecord): Candidate {
  return { id: record.id, name: record.name };
}

// The hits a ref takes: whole names before parts before searched words; of several, the one named exactly as written («макаронс» is Макаронс, not the word
// form of Макарон).
function chosenHits(hits: Hits): readonly Hit[] {
  const tier = [hits.whole, hits.part, hits.named].find((found) => found.length > 0) ?? [];
  const exact = tier.filter((hit) => hit.exact);
  return tier.length > 1 && exact.length === 1 ? exact : tier;
}

function fromHits(text: string, hits: Hits, records: readonly ShopRecord[], checked: boolean, lookup: Lookup): Ref {
  const chosen = chosenHits(hits);
  const [only] = chosen;
  const record = only === undefined ? undefined : records[only.index];
  if (chosen.length === 1 && only !== undefined && record !== undefined) return { text, status: "resolved", id: record.id, name: record.name, match: only.match };
  if (chosen.length > 1) return { text, status: "ambiguous", ...listed(picked(records, chosen.map((hit) => hit.index)).map(recordCandidate)) };
  return missed(text, checked, lookup);
}

// A group, price list or counterparty said by name (§3.6).
export function listRef(text: string, list: RecordIndex | null, partial: boolean, lookup: Lookup, confidence?: number): Ref {
  if (list === null || saidByNumber(text)) return scored({ text, status: "unchecked" }, confidence);
  return scored(fromHits(text, list.hits(text), list.records, !partial, lookup), confidence);
}

// A customer: the name the customer matcher found (`customers.ts`, D56, D61) as the record it names, else, with the list checked, the customers whose
// names start with the words said (ambiguous), else unknown.
export function customerRef(text: string, known: string | null, lookup: Lookup, partial: boolean, confidence?: number): Ref {
  const list = lookup.records?.lists.customers ?? null;
  if (list === null) return scored({ text, status: "unchecked" }, confidence);
  const owners = known === null ? [] : list.named(known);
  const [only] = owners;
  const record = only === undefined ? undefined : list.records[only];
  if (known !== null && owners.length === 1 && record !== undefined) {
    const match: Match = known !== record.name ? "alias" : nameWords(text).join(" ") === nameWords(record.name).join(" ") ? "exact" : "form";
    return scored({ text, status: "resolved", id: record.id, name: record.name, match }, confidence);
  }
  const words = nameWords(text);
  const starting = known !== null || lookup.customers === null || !words.length ? [] : lookup.customers.startingWith(words[0] ?? "").filter(([, name]) => name.length >= words.length && words.every((word, index) => nameMatch(word, name[index] ?? "")));
  // D71: the customers a name said in another order or in part may name («гуменюк» of two Гуменюк) are the candidates too.
  const spoken = known !== null || lookup.customers === null || !words.length ? [] : lookup.customers.spokenNames(words);
  const named = owners.length > 1 ? owners : [...new Set([...starting.map(([name]) => name), ...spoken].flatMap((name) => list.named(name)))].sort((left, right) => left - right);
  if (named.length > 1 && (known !== null || !partial)) return scored({ text, status: "ambiguous", ...listed(picked(list.records, named).map(recordCandidate)) }, confidence);
  return scored(missed(text, !partial, lookup), confidence);
}

function productCandidate(product: ShopProduct): Candidate {
  return { id: product.id, name: product.name };
}

// The products a product span names (§4.1 rule 1): the ref, and the indices of the product it resolves to or of the candidates.
export interface ProductFound {
  readonly ref: Ref;
  readonly indices: readonly number[];
}

export function productRef(text: string, lookup: Lookup, confidence?: number): ProductFound {
  const records = lookup.records;
  const products = records?.shop.products ?? null;
  if (records === null || products === null) return { ref: scored({ text, status: "unchecked" }, confidence), indices: [] };
  const chosen = chosenHits(records.products(text));
  const [only] = chosen;
  const product = only === undefined ? undefined : products[only.index];
  const indices = chosen.map((hit) => hit.index);
  if (chosen.length === 1 && only !== undefined && product !== undefined) return { ref: scored({ text, status: "resolved", id: product.id, name: product.name, match: only.match }, confidence), indices };
  if (chosen.length > 1) return { ref: scored({ text, status: "ambiguous", ...listed(picked(products, indices).map(productCandidate)) }, confidence), indices };
  return { ref: scored(missed(text, !records.shop.partial.has("products"), lookup), confidence), indices: [] };
}

function variantCandidates(product: ShopProduct, indices: readonly number[]): Listed {
  return listed(picked(product.variants ?? [], indices).map((variant) => ({ id: variant.id, name: variant.name, productId: product.id, ...(variant.label === null ? {} : { label: variant.label }) })));
}

function everyIndex(product: ShopProduct): number[] {
  return (product.variants ?? []).map((_, index) => index);
}

function intersection(sets: readonly (readonly number[])[]): number[] {
  const [first = [], ...rest] = sets;
  return first.filter((index) => rest.every((set) => set.includes(index)));
}

// The variants that match the most attrs: the candidates of a contradiction (rule 5), nothing dropped silently.
function mostMatched(matches: readonly (readonly number[])[]): number[] {
  const counts = new Map<number, number>();
  for (const set of matches) for (const index of set) counts.set(index, (counts.get(index) ?? 0) + 1);
  const most = Math.max(0, ...counts.values());
  return [...counts].filter(([, count]) => count === most).map(([index]) => index).sort((left, right) => left - right);
}

export interface VariantChoice {
  readonly variant: VariantRef;
  readonly attrs: readonly Attr[];
  readonly needs: readonly ParamNeed[];
}

// Attr words against one product's variants (§4.1 rules 2–9): `matches[i]` are the variants attr i names. Rules 2–5 run on the attrs that name some
// variant; the others keep their text with no variant and a non-blocking `unknown_attr` need (the card shows them, the order comment gets them: Q2).
export function chooseVariant(product: ShopProduct, texts: readonly string[], matches: readonly (readonly number[])[], confidences: Confidences = NO_CONFIDENCE): VariantChoice {
  const variants = product.variants ?? [];
  const attrs: Attr[] = texts.map((text, index) => scored({ text, variantIds: picked(variants, matches[index] ?? []).map((variant) => variant.id) }, confidences(text)));
  const unknownAttrs = attrs.flatMap((attr, index): ParamNeed[] => (attr.variantIds?.length ? [] : [{ path: `attrs[${index}]`, reason: "unknown_attr", blocking: false }]));
  if (!variants.length) return { variant: { status: "none" }, attrs, needs: unknownAttrs };
  const [single] = variants;
  if (!texts.length && variants.length === 1 && single !== undefined) return { variant: { status: "resolved", id: single.id, name: single.name, match: "only" }, attrs, needs: [] };
  if (!texts.length) return { variant: { status: "unspecified", ...variantCandidates(product, everyIndex(product)) }, attrs, needs: [blocking("variant", "variant_required")] };
  const known = matches.filter((set) => set.length > 0);
  if (!known.length) return { variant: { status: "unknown", ...variantCandidates(product, everyIndex(product)) }, attrs, needs: [blocking("variant", "variant_required")] };
  const common = intersection(known);
  const [one] = common;
  const chosen = one === undefined ? undefined : variants[one];
  if (common.length === 1 && chosen !== undefined) return { variant: { status: "resolved", id: chosen.id, name: chosen.name, match: "attrs" }, attrs, needs: unknownAttrs };
  return { variant: { status: "ambiguous", ...variantCandidates(product, common.length ? common : mostMatched(known)) }, attrs, needs: [blocking("variant", "ambiguous"), ...unknownAttrs] };
}

// The value in the product's unit (§4.2, Q7): a counting unit fits any product, a weight, volume, length or area converts within its dimension («500 г»
// of a product sold by the kilo is 0.5 kg, a tonne 1000 kg; D67: a tonne of a product sold by the tonne, or of one with no unit, stays a tonne), any other
// unit that is not the product's does not fit. A container that holds one piece (a pack, bottle, can or bucket) said for a product sold by the piece
// counts its pieces (D68: «шесть пачек молока» is 6 pcs, `unitText` keeps «пачек»); a box, set, bag or roll there does not fit.
interface Converted {
  readonly value: number | null;
  readonly unit: SaleUnit | null;
  readonly fits: boolean;
}

function converted(value: number | null, spoken: SaleUnit | null, sold: SaleUnit | null): Converted {
  if (sold === "pcs" && spoken !== null && PIECE_CONTAINERS.has(spoken)) return { value, unit: sold, fits: true };
  if (sold === null || spoken === null || spoken === sold || COUNTING_UNITS.has(spoken)) return { value, unit: spoken ?? sold, fits: true };
  const from = UNIT_SCALES.get(spoken);
  const to = UNIT_SCALES.get(sold);
  if (from === undefined || to === undefined || from[0] !== to[0]) return { value, unit: spoken, fits: false };
  return { value: value === null ? null : cleanNumber((value * from[1]) / to[1]), unit: sold, fits: true };
}

// The unit words of a quantity span: its unit words, and the unit a half is glued to («полтонны» → «тонны», D66; «пол-литра», D71).
function unitWords(text: string): string[] {
  return halvesJoined(text).replace(/ё/g, "е").split(/\s+/).flatMap((word) => {
    if (UNITS.has(word) || QUANTITY_UNIT_KEYS.has(word)) return [word];
    const half = HALF_GLUED.find((prefix) => word.startsWith(prefix) && QUANTITY_UNIT_KEYS.has(word.slice(prefix.length)));
    return half === undefined ? [] : [word.slice(half.length)];
  });
}

// «чотири колеса», «два диска» (D71): a word of the line's own product said in its quantity span after the number is what is counted, not a unit; the
// quantity counts pieces of the product («чотири колеса» of «Колесо для візка» is 4 pcs). A word that names no part of the product is left as it was.
function countedNoun(line: OrderLine, product: ShopProduct | null): string | null {
  const nouns = line.quantity?.toLowerCase().split(/\s+/).filter((word) => word && numberWordKind(word) === null && !/[0-9]/.test(word)) ?? [];
  const [noun] = nouns;
  if (nouns.length !== 1 || noun === undefined) return null;
  const own = [...nameTokens(line.product), ...(product === null ? [] : nameTokens(product.name))];
  return own.some((word) => tokenMatch(noun, word) !== null) ? noun : null;
}

// An order line's quantity (spec §7): the span or the D60 sum, its unit, the value in the product's unit when the product has one. A sum keeps its
// spoken unit: only a quantity said as one span converts.
export function quantityOf(line: OrderLine, product: ShopProduct | null, confidences: Confidences = NO_CONFIDENCE): Outcome<Quantity> {
  const asks = line.asks === true ? [blocking("quantity", "quantity_asks")] : [];
  if (line.quantity === undefined) return { value: { text: null, said: [], value: 1, unit: null, unitText: null, implicit: true }, needs: asks };
  const noun = unitWords(line.quantity).length ? null : countedNoun(line, product);
  const words = noun === null ? unitWords(line.quantity) : [noun];
  // «пару штук» counts pieces (D71): the couple word is no unit before another unit word.
  const said = words.find((word) => QUANTITY_UNIT_KEYS.has(word) && !(COUPLE_WORDS.has(word) && words.length > 1));
  const spoken = noun !== null ? "pcs" : said === undefined ? null : (QUANTITY_UNIT_KEYS.get(said) ?? null);
  const read = valueOf("quantity", line.quantity);
  const value = typeof read === "number" ? cleanNumber(read) : null;
  const single = line.said.length === 1 && line.said[0] === line.quantity;
  const unit = single ? converted(value, spoken, product?.unit ?? null) : { value, unit: spoken, fits: true };
  const needs = [...(unit.fits ? [] : [blocking("quantity", "unit_mismatch")]), ...(asks.length || value === null ? [blocking("quantity", "quantity_asks")] : [])];
  const text = single ? line.quantity : null;
  return { value: scored({ text, said: line.said, value: unit.value, unit: unit.unit, unitText: words.length ? words.join(" ") : null }, text === null ? undefined : confidences(text)), needs };
}

function bareNumber(text: string): boolean {
  const tokens = nameTokens(text);
  return tokens.length === 1 && isNumber(tokens[0] ?? "");
}

// A bare number the segmenter read as an attr but that names none of the product's variants, on a line with no quantity, is the quantity («чохол 3»):
// the catalogue decides between a size and a count (§4.2).
function numberAsQuantity(line: OrderLine, matches: readonly (readonly number[])[]): OrderLine {
  if (line.quantity !== undefined) return line;
  const numbers = line.attrs.flatMap((attr, index) => (bareNumber(attr) && !(matches[index] ?? []).length ? [attr] : []));
  const [quantity] = numbers;
  if (numbers.length !== 1 || quantity === undefined) return line;
  return { ...line, attrs: line.attrs.filter((attr) => attr !== quantity), quantity, said: [quantity] };
}

// «сукня вечірня червона» said as one product span: the product words then the attr words, or the other way round, taken when exactly one such reading
// names one product and its attr words name some of its variants (§4.1 rule 1, Shozee's head/tail split).
function splitReading(line: OrderLine, lookup: Lookup): OrderLine | null {
  const records = lookup.records;
  if (records === null) return null;
  const words = line.product.split(/\s+/).filter(Boolean);
  const readings: OrderLine[] = [];
  for (let cut = 1; cut < words.length; cut++) {
    const head = words.slice(0, cut).join(" ");
    const tail = words.slice(cut).join(" ");
    for (const [product, attr, first] of [[head, tail, false], [tail, head, true]] as const) {
      const found = productRef(product, lookup);
      const [index] = found.indices;
      if (found.ref.status !== "resolved" || index === undefined || !records.valuesOf(index)?.matching(attr).length) continue;
      readings.push({ ...line, product, attrs: first ? [attr, ...line.attrs] : saidOrder(line, [attr], lookup.text) });
    }
  }
  const [only] = readings;
  if (readings.length) return readings.length === 1 && only !== undefined ? only : null;
  return trailingAdjectives(line, words, records, lookup.text);
}

// D86 (F6): the line's attrs in the order said: its own attrs said before the product words, the words cut off the product's end, then the others
// («торт медовий | большой» is «медовий», «большой»).
function saidOrder(line: OrderLine, cut: readonly string[], text: string | undefined): string[] {
  const said = ` ${text ?? ""} `;
  const at = said.indexOf(` ${line.product} `);
  if (at < 0) return [...line.attrs, ...cut];
  const before = line.attrs.filter((attr) => {
    const where = said.indexOf(` ${attr} `);
    return where >= 0 && where < at;
  });
  return [...before, ...cut, ...line.attrs.filter((attr) => !before.includes(attr))];
}

// D86 (F6): «торт медовий большой», «шість тортів медових великих» where the context knows «торт» and no variant of it: a line product that names no
// catalogue product (not whole, in part nor by its words: the reading above found none), whose first words name exactly one product whole and whose other
// words are all adjectives, is that product, and the adjectives are attrs, one a word, unresolved as any attr of a product whose variants the context does
// not list. Only for a product with no variants the context knows (a v1 context, or none listed): a product with variants takes words that name them
// (the reading above) and else stays the unknown product it was said as. The longest such first words win.
function trailingAdjectives(line: OrderLine, words: readonly string[], records: Records, text: string | undefined): OrderLine | null {
  for (let cut = words.length - 1; cut > 0; cut--) {
    const tail = words.slice(cut);
    if (!tail.every((word) => adjectiveLike(word) && lettersOnly(word))) continue;
    const head = words.slice(0, cut).join(" ");
    const whole = [...new Set(records.products(head).whole.map((hit) => hit.index))];
    const [index] = whole;
    const product = index === undefined ? null : records.product(index);
    if (whole.length !== 1 || product === null) continue;
    return product.variants?.length ? null : { ...line, product: head, attrs: saidOrder(line, tail, text) };
  }
  return null;
}

const WHOLE_NUMBER = /^[0-9]+$/;

// D79: «тринадцять | п'ять мілілітрів», two attrs the model tagged apart that say one decimal («тринадцять і п'ять мілілітрів», 13,5 мл), are one attr
// when the first is a whole number that names no variant and the two, with the word said between them («і», «кома», «ціла»; none after a zero), name
// one (`records.ts` `decimalTokens`).
function decimalJoined(attrs: readonly string[], values: ProductValues | null, text: string | undefined): string[] {
  if (values === null || attrs.length < 2) return [...attrs];
  const said = ` ${text ?? ""} `;
  const out: string[] = [];
  for (let at = 0; at < attrs.length; at++) {
    const first = attrs[at] ?? "";
    const second = attrs[at + 1];
    const whole = nameTokens(first);
    const opens = second !== undefined && whole.length === 1 && WHOLE_NUMBER.test(whole[0] ?? "") && WHOLE_NUMBER.test(nameTokens(second)[0] ?? "");
    const joiner = !opens ? undefined : [...DECIMAL_JOINERS, ...(whole[0] === "0" ? [""] : [])].find((word) => said.includes(` ${[first, word, second].filter(Boolean).join(" ")} `));
    const joined = joiner === undefined ? null : [first, joiner, second].filter(Boolean).join(" ");
    if (joined !== null && !values.matching(first).length && values.matching(joined).length) {
      out.push(joined);
      at += 1;
    } else out.push(first);
  }
  return out;
}

// One order line resolved (§4.1): the product (by its attrs when its name fits several, rule 4), the attrs and the variant, the quantity, and what the
// card still needs, with paths relative to the item.
export function resolveItem(said: OrderLine, lookup: Lookup, confidences: Confidences = NO_CONFIDENCE): Outcome<OrderItem> {
  const records = lookup.records;
  const first = productRef(said.product, lookup, confidences(said.product));
  const split = first.ref.status === "unknown" ? splitReading(said, lookup) : null;
  const line = split ?? said;
  const found = split === null ? first : productRef(line.product, lookup, confidences(line.product));
  const matchesFor = (index: number, attrs: readonly string[]) => attrs.map((attr) => records?.valuesOf(index)?.matching(attr) ?? []);
  const productAt = (index: number | undefined) => (index === undefined ? null : (records?.product(index) ?? null));
  let ref = found.ref;
  let index = ref.status === "resolved" ? found.indices[0] : undefined;
  if (ref.status === "ambiguous" && line.attrs.length) {
    const kept = found.indices.filter((candidate) => {
      const known = matchesFor(candidate, line.attrs).filter((set) => set.length > 0);
      return known.length > 0 && intersection(known).length > 0;
    });
    const [only] = kept;
    const product = productAt(only);
    if (kept.length === 1 && product !== null) {
      index = only;
      ref = scored({ text: ref.text, status: "resolved", id: product.id, name: product.name, match: "attrs" }, confidences(ref.text));
    } else if (kept.length > 1 && records !== null) ref = { ...ref, ...listed(picked(records.shop.products ?? [], kept).map(productCandidate)) };
  }
  const needs: ParamNeed[] = ref.status === "ambiguous" || ref.status === "unknown" ? [blocking("product", ref.status)] : [];
  const product = productAt(index);
  if (index === undefined || product === null || product.variants === null) {
    const quantity = quantityOf(line, product, confidences);
    const attrs = line.attrs.map((text): Attr => scored({ text, variantIds: null }, confidences(text)));
    return { value: { product: ref, attrs, variant: { status: "unchecked" }, quantity: quantity.value }, needs: [...needs, ...quantity.needs] };
  }
  const joined = { ...line, attrs: decimalJoined(line.attrs, records?.valuesOf(index) ?? null, lookup.text) };
  const counted = numberAsQuantity(joined, matchesFor(index, joined.attrs));
  const choice = chooseVariant(product, counted.attrs, matchesFor(index, counted.attrs), confidences);
  const quantity = quantityOf(counted, product, confidences);
  return { value: { product: ref, attrs: choice.attrs, variant: choice.variant, quantity: quantity.value }, needs: [...needs, ...choice.needs, ...quantity.needs] };
}

// A catalogue `variant` param (catalog.*Variant, pricing.*Entries, §3.6): its attr words matched inside the product said with it, else across every
// product, whose candidates carry their product's id.
export function resolveVariant(texts: readonly string[], productIndex: number | null, lookup: Lookup, confidences: Confidences = NO_CONFIDENCE): VariantChoice {
  const records = lookup.records;
  const products = records?.shop.products ?? null;
  const unchecked = (): VariantChoice => ({ variant: { status: "unchecked" }, attrs: texts.map((text) => scored({ text, variantIds: null }, confidences(text))), needs: [] });
  if (records === null || products === null) return unchecked();
  const product = productIndex === null ? null : records.product(productIndex);
  if (product !== null && product.variants !== null) {
    const attrs = decimalJoined(texts, records.valuesOf(productIndex ?? -1), lookup.text);
    return chooseVariant(product, attrs, attrs.map((text) => records.valuesOf(productIndex ?? -1)?.matching(text) ?? []), confidences);
  }
  if (product !== null) return unchecked();
  const everywhere = products.flatMap((candidate, index) => {
    if (candidate.variants === null || !candidate.variants.length) return [];
    const matches = texts.map((text) => records.valuesOf(index)?.matching(text) ?? []);
    const known = matches.filter((set) => set.length > 0);
    const common = known.length === texts.length ? intersection(known) : [];
    return common.length ? [{ candidate, matches, common }] : [];
  });
  const [only] = everywhere;
  if (everywhere.length === 1 && only !== undefined) return chooseVariant(only.candidate, texts, only.matches, confidences);
  const attrs = texts.map((text) => scored({ text, variantIds: null }, confidences(text)));
  if (!everywhere.length) return { variant: { status: records.shop.partial.has("products") ? "unchecked" : "unknown" }, attrs, needs: records.shop.partial.has("products") ? [] : [blocking("variant", "unknown")] };
  const candidates = everywhere.flatMap(({ candidate, common }) => variantCandidates(candidate, common).candidates);
  return { variant: { status: "ambiguous", ...listed(candidates) }, attrs, needs: [blocking("variant", "ambiguous")] };
}
