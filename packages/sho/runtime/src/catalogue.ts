import type { Bundle, Intent } from "./bundle.ts";
import { isContextV2, shopOf, type Context, type Shop } from "./context.ts";
import { CONNECTORS, COUNTED_ENDINGS, HALF, LABEL_WORDS, LINE_WITH, PREPOSITIONS, WITHOUT } from "./lexicon/catalogue.ts";
import { HEDGE_WORDS } from "./lexicon/repair.ts";
import { SINGLE_UNITS, SPAN_SINGLE_UNITS, SPEC_UNITS, UNITS } from "./lexicon/units.ts";
import { linesBySide, type LinePiece, type OrderLine } from "./lines.ts";
import { numberRange, numberWordKind, valueOf } from "./numbers.ts";
import type { Params } from "./params.ts";
import { REPAIR_WORDS, markerWords, takesBack, trailingMarkers, withoutHedges } from "./repair.ts";
import type { TaggedSpan } from "./spans.ts";
import { NameIndex } from "./nameIndex.ts";
import { NameList } from "./nameList.ts";
import { PART_STOPS, isCyrillic, nameFit, nameTokens, spelledSize, tokenMatch, type NameFit } from "./names.ts";
import { Records, fullNames } from "./records.ts";
import { adjectiveLike, lettersOnly } from "./words.ts";

export type CatalogueKind = "product" | "variant";
export type PieceKind = CatalogueKind | "quantity" | "unknown" | "gap";
export type Piece = readonly [kind: PieceKind, text: string];
export type MergedKind = CatalogueKind | "quantity" | "new";
export type Merged = readonly [kind: MergedKind, text: string, gap?: readonly string[]];
export type Quantity = readonly [length: number, text: string];

export interface CompiledContext {
  readonly empty: boolean;
  readonly customers: NameList;
  readonly longest: number;
  readonly records: Records;
  match(words: readonly string[]): CatalogueKind | null;
  find(words: readonly string[]): CatalogueHit | null;
  productsNamed(words: readonly string[]): number;
}

// What spoken words name in the catalogue: an entry's kind, and whether they said only a part of its name (D64).
export interface CatalogueHit {
  readonly kind: CatalogueKind;
  readonly fit: NameFit;
}

export const ITEMS_PARAM = "items";
export const CUSTOMER_PARAM = "customer";

// A name the segmenter knows: a product's name, brand form or alias (`products` are the products it names), or an attribute value of the vocabulary.
interface Entry {
  readonly kind: CatalogueKind;
  readonly tokens: readonly string[];
  readonly products: readonly number[];
  // An alias of a product: the shop's own spoken form (D66, `names.ts` `tokenMatch`).
  readonly alias: boolean;
}

type Merging = readonly [kind: MergedKind | "with", text: string, gap: readonly string[]];
type Scored = readonly [score: number, pieces: readonly Piece[]];
type Placed = readonly [word: string, at: number];

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function entriesOf(shop: Shop): Entry[] {
  const entries = new Map<string, { readonly kind: CatalogueKind; readonly tokens: readonly string[]; readonly products: number[]; alias: boolean }>();
  const add = (kind: CatalogueKind, name: string, product: number | null, alias = false) => {
    const key = `${kind} ${name.toLowerCase()}`;
    const known = entries.get(key);
    if (known === undefined) {
      const tokens = nameTokens(name);
      if (tokens.length) entries.set(key, { kind, tokens, products: product === null ? [] : [product], alias });
      return;
    }
    known.alias ||= alias;
    if (product !== null && !known.products.includes(product)) known.products.push(product);
  };
  for (const [index, product] of (shop.products ?? []).entries()) {
    for (const name of fullNames(product)) add("product", name, index);
    for (const alias of product.aliases) add("product", alias, index, true);
  }
  for (const value of shop.vocabulary) add("variant", value, null);
  return [...entries.values()];
}

// Names of one product only (its name and its name without the brand, «Nike Air Max 90» and «Air Max 90»): a part that fits them names that product.
function oneProduct(entries: readonly Entry[]): boolean {
  const [first] = entries;
  const product = first?.products.length === 1 ? first.products[0] : undefined;
  return product !== undefined && entries.every((entry) => entry.kind === "product" && entry.products.length === 1 && entry.products[0] === product);
}

// The compiled context (§2.4 of docs/design/sho-api-v2.md): the segmenter's names under a token index, the customer names, and the record lookups.
export class Catalogue implements CompiledContext {
  readonly customers: NameList;
  readonly longest: number;
  readonly records: Records;
  private readonly entries: readonly Entry[];
  private readonly index: NameIndex;
  // What `find` gave each run of words: an utterance probes the same runs many times (the segmenter, the item range, the customer rules).
  private readonly found = new Map<string, CatalogueHit | null>();

  constructor(shop: Shop) {
    this.records = new Records(shop);
    const customers = this.records.lists.customers;
    this.customers = new NameList(customers?.names() ?? [], (name) => customers?.named(name) ?? []);
    this.entries = entriesOf(shop);
    this.index = new NameIndex(
      this.entries.map((entry) => entry.tokens),
      new Set(this.entries.flatMap((entry, index) => (entry.alias ? [index] : []))),
    );
    this.longest = Math.max(1, ...this.entries.map((entry) => entry.tokens.length));
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  // The entries the words may fit, with the fit: the whole name is as long as the words (or the letter size they spell); a longer name only when a part of
  // it can say enough, which words all in Cyrillic do only through a Latin token they match by sound.
  private fits(spoken: readonly string[]): (readonly [Entry, NameFit | null])[] {
    const soundly = spoken.every(isCyrillic) ? this.index.bySound(spoken) : null;
    const shortest = spelledSize(spoken) === null ? spoken.length : 1;
    return this.index.candidates(spoken).flatMap((at) => {
      const entry = this.entries[at];
      if (entry === undefined || entry.tokens.length < shortest) return [];
      if (entry.tokens.length > spoken.length && soundly !== null && !soundly.has(at)) return [];
      return [[entry, nameFit(spoken, entry.tokens, { alias: entry.alias })] as const];
    });
  }

  // The whole name of an entry, a product before a variant; else a part of exactly one entry's name (D64: a part that fits two names names neither).
  find(words: readonly string[]): CatalogueHit | null {
    const said = words.join(" ");
    const known = this.found.get(said);
    if (known !== undefined) return known;
    if (this.found.size >= FOUND_KEPT) this.found.clear();
    const hit = this.lookup(nameTokens(said));
    this.found.set(said, hit);
    return hit;
  }

  private lookup(spoken: readonly string[]): CatalogueHit | null {
    if (!spoken.length || spoken.length > this.longest) return null;
    const fits = this.fits(spoken);
    const whole = fits.filter(([, fit]) => fit === "whole").map(([entry]) => entry.kind);
    if (whole.length) return { kind: whole.includes("product") ? "product" : (whole[0] ?? "product"), fit: "whole" };
    const parts = fits.flatMap(([entry, fit]) => (fit === "part" ? [entry] : []));
    const [only] = parts;
    return only !== undefined && (parts.length === 1 || oneProduct(parts)) ? { kind: only.kind, fit: "part" } : null;
  }

  match(words: readonly string[]): CatalogueKind | null {
    return this.find(words)?.kind ?? null;
  }

  // How many products the words speak of, as a search does: products whose name holds every word said (by `tokenMatch`), stop words aside («сукні» speaks
  // of «сукня вечірня» and «сукня коктейльна», D64).
  productsNamed(words: readonly string[]): number {
    const spoken = nameTokens(words.join(" ")).filter((token) => !PART_STOPS.has(token));
    if (!spoken.length) return 0;
    const named = new Set<number>();
    for (const at of this.index.candidates(spoken)) {
      const entry = this.entries[at];
      if (entry?.kind === "product" && spoken.every((token) => entry.tokens.some((known) => tokenMatch(token, known, { alias: entry.alias }) !== null))) for (const product of entry.products) named.add(product);
    }
    return named.size;
  }
}

const FOUND_KEPT = 50_000;

// Compiled contexts by revision: a host that sends the same revision again gets the index built the first time (§2.4).
const COMPILED = new Map<string, CompiledContext>();
const COMPILED_KEPT = 4;

export function compileContext(context: Context): CompiledContext {
  const revision = isContextV2(context) ? context.revision : undefined;
  const known = revision === undefined ? undefined : COMPILED.get(revision);
  if (known !== undefined) return known;
  const compiled = new Catalogue(shopOf(context));
  if (revision !== undefined) {
    COMPILED.set(revision, compiled);
    for (const old of COMPILED.keys()) if (COMPILED.size > COMPILED_KEPT) COMPILED.delete(old);
  }
  return compiled;
}

// Units come after the number they count: «2 кг», «пів кіло», never «кіло 400» (D64).
function unitsLast(piece: readonly string[]): boolean {
  const unit = piece.findIndex((word) => UNITS.has(word));
  return unit !== 0 && (unit < 0 || piece.slice(unit).every((word) => UNITS.has(word)));
}

// A number said with a unit that measures a product («256 гб», «1200 Вт», «65 дюймів») is part of a name or a variant, never a quantity (D64).
function measuresProduct(words: readonly string[], start: number): boolean {
  let at = start;
  while (at < words.length && valueOf("quantity", words[at] ?? "") !== null) at += 1;
  return at > start && SPEC_UNITS.has(words[at] ?? "");
}

// A quantity at `start`: its length in words and its text. A range («два-три круасани», D67) is a quantity with no number: the card asks how many.
export function quantityAt(words: readonly string[], start: number): Quantity | null {
  if (measuresProduct(words, start)) return null;
  const first = words[start] ?? "";
  if (SPAN_SINGLE_UNITS.has(first) && !SINGLE_UNITS.has(first)) return null; // «відро» may be a product; only a span the model tagged reads it (D68)
  for (let length = Math.min(3, words.length - start); length > 0; length--) {
    const piece = words.slice(start, start + length);
    const text = piece.join(" ");
    const first = piece[0] ?? "";
    if (length === 1 && SINGLE_UNITS.has(first)) return [1, text];
    if (!unitsLast(piece)) continue;
    const numbers = piece.filter((word) => !UNITS.has(word) && word !== HALF);
    const range = numbers.length === 1 && numberRange(numbers[0] ?? "") !== null;
    const numeric = numbers.length <= 1 && numbers.every((word) => valueOf("quantity", word) !== null);
    if (range || (numeric && (numbers.length > 0 || piece.includes(HALF)) && valueOf("quantity", text) !== null)) return [length, text];
  }
  return null;
}

// Unit forms said after a number («три ящика»), which alone name no quantity of their own (D71).
const NUMERAL_FORMS: ReadonlySet<string> = new Set(["ящика"]);

// A part of a name scores a little below the whole name said in as many words, and above a number read as a quantity («128» of «128 ГБ», D64).
const PART_COST = 0.5;

// A model's product span of several words that names products as a whole (a name, a part of one, or a search of its words), which the catalogue alone
// would cut in two («бойлер | дражіце», «хлеб | дубова», «штори | аш ем хоум»): the segmenter takes it whole, by its first word's index and its length
// (D71).
export type Kept = ReadonlyMap<number, number>;

// A kept span scores above every cut of its words into catalogue names.
const KEPT_BONUS = 1;

export function segment(words: readonly string[], catalogue: CompiledContext, kept: Kept = new Map()): readonly Piece[] {
  const memo = new Map<number, Scored>();
  const markers = markerWords(words);
  const best = (start: number): Scored => {
    if (start === words.length) return [0, []];
    const known = memo.get(start);
    if (known !== undefined) return known;
    const word = words[start] ?? "";
    const options: Scored[] = [];
    const followingKnown = start + 1 < words.length && Boolean(catalogue.match(words.slice(start + 1, start + 2)) || quantityAt(words, start + 1));
    if (CONNECTORS.has(word) || REPAIR_WORDS.has(word) || HEDGE_WORDS.has(word) || LABEL_WORDS.has(word) || markers.has(start) || (PREPOSITIONS.has(word) && (followingKnown || start + 1 === words.length))) {
      const [score, rest] = best(start + 1);
      options.push([score, [["gap", word], ...rest]]);
    }
    const without = words[start + 1];
    if (WITHOUT.has(word) && without !== undefined && catalogue.match([without]) === "variant") {
      const [score, rest] = best(start + 2);
      options.push([score + 4, [["variant", `${word} ${without}`], ...rest]]);
    }
    const found = quantityAt(words, start);
    // A unit in the form a number takes («ящика» of «три ящика») right after a number word belongs to that number: it is no quantity of its own (D71).
    const loneAfterNumber = found !== null && found[0] === 1 && start > 0 && NUMERAL_FORMS.has(words[start] ?? "") && numberWordKind(words[start - 1] ?? "") !== null;
    if (found && !loneAfterNumber) {
      const [score, rest] = best(start + found[0]);
      options.push([score + found[0], [["quantity", found[1]], ...rest]]);
    }
    for (let length = Math.min(catalogue.longest, words.length - start); length > 0; length--) {
      const piece = words.slice(start, start + length);
      const hit = catalogue.find(piece);
      if (hit) {
        const [score, rest] = best(start + length);
        options.push([score + length * 2 - (hit.fit === "part" ? PART_COST : 0), [[hit.kind, piece.join(" ")], ...rest]]);
      }
    }
    const whole = kept.get(start);
    if (whole !== undefined && start + whole <= words.length) {
      const [score, rest] = best(start + whole);
      options.push([score + whole * 2 + KEPT_BONUS, [["product", words.slice(start, start + whole).join(" ")], ...rest]]);
    }
    const [score, rest] = best(start + 1);
    options.push([score - 1, [["unknown", word], ...rest]]);
    const chosen = options.reduce((best, option) => (option[0] > best[0] ? option : best));
    memo.set(start, chosen);
    return chosen;
  };
  return best(0)[1];
}

// Two unknown words are one new product unless a marker or a joiner comes between them: «5 квасів і кисіль 2» is two products (D61).
function gluesTo(last: Merging, gap: readonly string[]): boolean {
  return last[0] === "new" && trailingMarkers(gap) === 0 && !gap.some((word) => CONNECTORS.has(word));
}

export function mergedUnknowns(pieces: readonly Piece[]): Merged[] {
  const merged: Merging[] = [];
  let gap: string[] = [];
  for (const [kind, text] of pieces) {
    if (kind === "gap") {
      gap.push(...withoutHedges([text]));
      continue;
    }
    const last = merged.at(-1);
    const beforeLast = merged.at(-2);
    const afterProduct = merged.length > 1 && (beforeLast?.[0] === "new" || beforeLast?.[0] === "product");
    if (kind === "product" && last !== undefined && (!afterProduct || last[0] === "product") && (last[0] === "new" || last[0] === "product") && adjectiveLike(last[1])) {
      merged[merged.length - 1] = ["product", `${last[1]} ${text}`, last[2]];
    } else if (kind === "unknown" && last?.[0] === "with") {
      merged[merged.length - 1] = ["variant", text, [...last[2], last[1], ...gap]];
    } else if (kind === "unknown" && LINE_WITH.has(text) && last?.[0] === "product") {
      merged.push(["with", text, gap]);
    } else if (kind === "unknown" && last !== undefined && gluesTo(last, gap)) {
      merged[merged.length - 1] = ["new", `${last[1]} ${text}`, last[2]];
    } else {
      merged.push([kind === "unknown" ? "new" : kind, text, gap]);
    }
    gap = [];
  }
  const kept: Merged[] = [];
  let dropped: string[] = [];
  for (const [kind, text, before] of merged) {
    if (kind === "with" || (kind === "new" && PREPOSITIONS.has(text))) dropped = [...dropped, ...before, text];
    else {
      kept.push([kind, text, [...dropped, ...before]]);
      dropped = [];
    }
  }
  return kept;
}

export function linesOf(raw: readonly Merged[], catalogue: CompiledContext, takeBack = false): OrderLine[] | null {
  const pieces = raw.map(([kind, text, gap = []], index): LinePiece => {
    const before = raw[index - 1]?.[0];
    const mayBeVariant = kind === "new" && !text.includes(" ") && (before === "product" || before === "new");
    const unknown = kind === "variant" && catalogue.match(wordsOf(text)) !== "variant";
    return { kind: kind === "new" ? "product" : kind, text, gap, mayBeVariant, ...(unknown ? { unknown } : {}) };
  });
  const reading = linesBySide(pieces, takeBack);
  return reading === null || reading.orphans > 0 ? null : reading.lines;
}

// A back-marker run after the last item of a segmented range (its trailing gap, then `rest`, the words said after the range) with no item word after
// it: the last repair is taken back (D61).
function takenBack(segmented: readonly Piece[], rest: readonly string[], catalogue: CompiledContext): boolean {
  const tail = segmented.length - segmented.findLastIndex(([kind]) => kind !== "gap") - 1;
  const after = [...segmented.slice(segmented.length - tail).map(([, text]) => text), ...rest];
  return takesBack(after) && !after.some((word) => itemWord(word, catalogue));
}

export function trailingLines(utterance: string, customer: string, catalogue: CompiledContext): OrderLine[] | null {
  const start = utterance.indexOf(customer);
  if (start < 0) return null;
  const words = wordsOf(utterance.slice(start + customer.length));
  const segmented = segment(words, catalogue);
  const pieces = words.length ? mergedUnknowns(segmented) : [];
  if (!pieces.length || pieces.some(([kind]) => kind === "new")) return null;
  const lines = linesOf(pieces, catalogue, takenBack(segmented, [], catalogue));
  return lines && lines.length ? lines : null;
}

function countedNoun(text: string): boolean {
  return !adjectiveLike(text) && COUNTED_ENDINGS.some((ending) => text.endsWith(ending));
}

function quantityFirst(line: readonly Merged[]): boolean {
  const beforeVariant = line.at(-2)?.[0];
  return beforeVariant === "quantity" || (beforeVariant === "product" && line.at(-3)?.[0] === "quantity");
}

export function variantContinues(before: readonly Merged[], piece: Merged, following: Merged | undefined, products: ReadonlySet<string>): boolean {
  const [kind, text, gap = []] = piece;
  const quantity = before.at(-1);
  const previous = before.at(-2);
  if (kind !== "new" || quantity?.[0] !== "quantity" || previous?.[0] !== "variant") return false;
  if (!lettersOnly(text) || products.has(text) || countedNoun(text) || gap.some((word) => CONNECTORS.has(word))) return false;
  const ownQuantity = following?.[0] === "quantity" || quantityFirst(before.slice(0, -1));
  return ownQuantity && before.some(([earlier]) => earlier === "product" || earlier === "new");
}

export function modelVariants(merged: readonly Merged[], variants: ReadonlySet<string>, products: ReadonlySet<string>): Merged[] {
  const pieces: Merged[] = [];
  for (const [index, piece] of merged.entries()) {
    const [kind, text, gap = []] = piece;
    const variant = kind === "new" && variants.has(text) && (pieces.at(-1)?.[0] === "product" || variantContinues(pieces, piece, merged[index + 1], products));
    pieces.push([variant ? "variant" : kind, text, gap]);
  }
  return pieces;
}

function wordsBehind(utterance: string, start: number, others: readonly TaggedSpan[]): Placed[] {
  const behind: Placed[] = [];
  let end = start;
  for (const word of wordsOf(utterance.slice(0, start)).reverse()) {
    const at = utterance.lastIndexOf(word, end - word.length);
    if (others.some((span) => span.start <= at && at < span.end)) break;
    behind.push([word, at]);
    end = at;
  }
  return behind;
}

function quantityWord(word: string): boolean {
  return quantityAt([word], 0) !== null || valueOf("quantity", word) !== null;
}

function itemWord(word: string, catalogue: CompiledContext): boolean {
  return quantityWord(word) || catalogue.match([word]) === "product";
}

function repairedUnit(behind: readonly string[], firstKind: string, fields: Bundle["lineFields"], catalogue: CompiledContext): number {
  const run = trailingMarkers(behind.toReversed());
  const unit = behind[run];
  if (run === 0 || unit === undefined) return 0;
  const quantity = firstKind === fields.quantity && quantityWord(unit);
  const variant = firstKind === fields.variant && lettersOnly(unit) && !itemWord(unit, catalogue) && catalogue.match([behind[run + 1] ?? ""]) === "product";
  return quantity || variant ? run + 1 : 0;
}

function itemsStart(utterance: string, start: number, firstKind: string | null, others: readonly TaggedSpan[], fields: Bundle["lineFields"], catalogue: CompiledContext): number {
  const behind = wordsBehind(utterance, start, others);
  const words = behind.map(([word]) => word);
  let taken = firstKind === null ? 0 : repairedUnit(words, firstKind, fields, catalogue);
  while (taken < words.length && itemWord(words[taken] ?? "", catalogue)) taken += 1;
  return behind[taken - 1]?.[1] ?? start;
}

function placed(utterance: string): Placed[] {
  return Array.from(utterance.matchAll(/\S+/g), (match) => [match[0], match.index] as const);
}

function wholeProduct(words: readonly Placed[], from: number, to: number, catalogue: CompiledContext): boolean {
  const hit = catalogue.find(words.slice(from, to).map(([word]) => word));
  return hit?.kind === "product" && hit.fit === "whole";
}

// The item range grows over a catalogue name it cuts at an edge («дві маски | для волосся», «крем для | обличчя»), and over items the model left untagged
// after it («… і 1 тонік»), never over a word of a kept param (the customer): D64. Returns the range's new character bounds.
function itemRange(utterance: string, start: number, end: number, keep: readonly string[], catalogue: CompiledContext): readonly [start: number, end: number] {
  const words = placed(utterance);
  const kept = new Set(keep.flatMap((text) => {
    const at = utterance.indexOf(text);
    return at < 0 ? [] : words.flatMap(([, where], index) => (where >= at && where < at + text.length ? [index] : []));
  }));
  const first = words.findIndex(([, at]) => at >= start);
  const after = words.findIndex(([, at]) => at >= end);
  if (first < 0) return [start, end];
  let from = first;
  let to = after < 0 ? words.length : after;
  const longest = catalogue.longest;
  for (let back = Math.min(longest - 1, from); back > 0; back--) {
    const open = Array.from({ length: back }, (_, offset) => from - 1 - offset).every((index) => !kept.has(index));
    if (open && Array.from({ length: longest }, (_, size) => from + size + 1).some((stop) => stop <= to && wholeProduct(words, from - back, stop, catalogue))) {
      from -= back;
      break;
    }
  }
  for (let ahead = Math.min(longest - 1, words.length - to); ahead > 0; ahead--) {
    const open = Array.from({ length: ahead }, (_, offset) => to + offset).every((index) => !kept.has(index));
    if (open && Array.from({ length: longest }, (_, size) => to - size - 1).some((begin) => begin >= from && wholeProduct(words, begin, to + ahead, catalogue))) {
      to += ahead;
      break;
    }
  }
  to = trailingItems(words, trailingAttrs(words, to, kept, catalogue), kept, catalogue);
  const last = words[to - 1];
  return [words[from]?.[1] ?? start, last === undefined ? end : last[1] + last[0].length];
}

// «… дві чорні сукні вечірні розмір m»: attribute values the catalogue knows, said right after the range with only label words before them, are the last
// line's attrs (D65).
function trailingAttrs(words: readonly Placed[], to: number, kept: ReadonlySet<number>, catalogue: CompiledContext): number {
  let at = to;
  let reached = to;
  while (at < words.length && !kept.has(at)) {
    const word = words[at]?.[0] ?? "";
    if (LABEL_WORDS.has(word)) at += 1;
    else if (catalogue.match([word]) === "variant") reached = ++at;
    else break;
  }
  return reached;
}

// «… і 1 тонік»: joiners, quantities and whole catalogue products after the range, up to the last product among them.
function trailingItems(words: readonly Placed[], to: number, kept: ReadonlySet<number>, catalogue: CompiledContext): number {
  let at = to;
  let reached = to;
  while (at < words.length && !kept.has(at)) {
    const word = words[at]?.[0] ?? "";
    const size = Array.from({ length: catalogue.longest }, (_, length) => catalogue.longest - length).find((length) => at + length <= words.length && Array.from({ length }, (_, offset) => at + offset).every((index) => !kept.has(index)) && wholeProduct(words, at, at + length, catalogue));
    if (size !== undefined) {
      at += size;
      reached = at;
    } else if (CONNECTORS.has(word) || quantityWord(word)) at += 1;
    else break;
  }
  return reached;
}

// The model's product spans in the item range that the catalogue names only as a whole (D71, `Kept`): two words or more, named by the product lookup
// (whole, part or search), and no catalogue name or part of one as said (such a span the segmenter finds itself, and may grow: «air max» to «air max 90»).
function keptSpans(utterance: string, start: number, end: number, products: readonly TaggedSpan[], catalogue: CompiledContext): Kept {
  const offsets = Array.from(utterance.slice(start, end).matchAll(/\S+/g), (match) => start + match.index);
  const kept = new Map<number, number>();
  for (const span of products) {
    const words = wordsOf(span.text);
    const at = offsets.indexOf(span.start);
    if (at < 0 || words.length < 2 || catalogue.find(words) !== null) continue;
    const hits = catalogue.records.products(span.text);
    if (hits.whole.length + hits.part.length + hits.named.length > 0) kept.set(at, words.length);
  }
  return kept;
}

export function resegment(bundle: Pick<Bundle, "lineFields">, utterance: string, spans: readonly TaggedSpan[], catalogue: CompiledContext, startHint: number | null = null, keep: readonly string[] = []): OrderLine[] | null {
  const fields = bundle.lineFields;
  const kinds = new Set([fields.product, fields.quantity, fields.variant]);
  const items = spans.filter((span) => kinds.has(span.kind));
  const first = items.reduce<TaggedSpan | null>((earliest, span) => (earliest === null || span.start < earliest.start ? span : earliest), null);
  if (first === null) return null;
  const hinted = startHint !== null && startHint < first.start;
  const others = spans.filter((span) => !kinds.has(span.kind));
  const [start, end] = itemRange(utterance, itemsStart(utterance, hinted ? startHint : first.start, hinted ? null : first.kind, others, fields, catalogue), Math.max(...items.map((span) => span.end)), keep, catalogue);
  const tagged = (kind: string): ReadonlySet<string> => new Set(items.filter((span) => span.kind === kind).map((span) => span.text));
  const segmented = segment(wordsOf(utterance.slice(start, end)), catalogue, keptSpans(utterance, start, end, items.filter((span) => span.kind === fields.product), catalogue));
  const pieces = modelVariants(mergedUnknowns(segmented), tagged(fields.variant), tagged(fields.product));
  const lines = linesOf(pieces, catalogue, takenBack(segmented, wordsOf(utterance.slice(end)), catalogue));
  return lines && lines.length ? lines : null;
}

export function catalogueLines(
  bundle: Pick<Bundle, "lineFields">,
  intent: Intent,
  utterance: string,
  spans: readonly TaggedSpan[],
  params: Params,
  catalogue: CompiledContext,
  startHint: number | null,
): OrderLine[] | null {
  const customer = params[CUSTOMER_PARAM];
  if (Array.isArray(params[ITEMS_PARAM])) return resegment(bundle, utterance, spans, catalogue, startHint, typeof customer === "string" ? [customer] : []);
  if (Object.hasOwn(intent.params, ITEMS_PARAM) && typeof customer === "string") return trailingLines(utterance, customer, catalogue);
  return null;
}
