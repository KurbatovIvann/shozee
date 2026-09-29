import { COLOUR_COUNTS, CONNECTORS, LABEL_WORDS, PREPOSITIONS } from "./lexicon/catalogue.ts";
import { ADD_CUES, ADD_JOINERS, BACK_MARKERS, COMBINED_MARKERS, HALT_WORDS, HEDGE_WORDS, ITEM_LEAD_WORDS, LONE_MARKERS, PHRASE_MARKERS, REPAIR_MARKERS } from "./lexicon/repair.ts";
import { PIECE_UNITS, UNITS } from "./lexicon/units.ts";
import type { LineKind, LinePiece, OrderLine } from "./lines.ts";
import { canonicalNumber, cleanNumber, valueOf } from "./numbers.ts";
import { adjectiveLike, wordMatch } from "./words.ts";

export type MarkerEdges = readonly [lead: readonly string[], core: readonly string[], trail: readonly string[]];

type Phrases = readonly (readonly string[])[];
// How far a marker run reaches (D59): `strong` replaces whatever it corrects, a new product's line too; `lone` («ні», «нет») repairs only between values or
// the same product; `back` («хоча ні», «правильно», «все-таки») only between two values of the same kind, a product for a product.
type Strength = "strong" | "lone" | "back";

function phrasesOf(phrases: readonly string[]): Phrases {
  return phrases.map((phrase) => phrase.split(" "));
}

const PHRASES: Phrases = phrasesOf([...REPAIR_MARKERS, ...COMBINED_MARKERS, ...PHRASE_MARKERS, ...BACK_MARKERS]);
const CONDITIONAL: Phrases = phrasesOf([...BACK_MARKERS, ...LONE_MARKERS]);
const LONGEST_UNIT = 2;
// A line has at most three parts: a quantity, a product and a run of attributes (`lines.ts` `SHAPES`).
const LONGEST_LINE = 3;
const HALTS: ReadonlySet<string> = new Set(HALT_WORDS);
const CUES: ReadonlySet<string> = new Set(ADD_CUES);

// The words of the markers that stand alone; a halt word («стоп») is a marker word only where a combination covers it (`markerWords`).
export const REPAIR_WORDS: ReadonlySet<string> = new Set(REPAIR_MARKERS.flatMap((phrase) => phrase.split(" ")));

function phrasesAt(words: readonly string[], start: number, phrases: Phrases = PHRASES): number[] {
  return phrases.filter((phrase) => phrase.every((word, offset) => words[start + offset] === word)).map((phrase) => phrase.length);
}

// The longest start of `words` that is a run of marker phrases («ой ні стоп» is «ой» + «ні стоп»).
function leadingMarkers(words: readonly string[], phrases: Phrases = PHRASES): number {
  const reached = new Set([0]);
  let longest = 0;
  for (let at = 0; at < words.length; at++) {
    if (!reached.has(at)) continue;
    for (const length of phrasesAt(words, at, phrases)) {
      reached.add(at + length);
      longest = Math.max(longest, at + length);
    }
  }
  return longest;
}

export function markerWords(words: readonly string[]): ReadonlySet<number> {
  const covered = new Set<number>();
  for (let at = 0; at < words.length; at++) for (const length of phrasesAt(words, at)) for (let offset = 0; offset < length; offset++) covered.add(at + offset);
  return covered;
}

export function markerRun(words: readonly string[]): boolean {
  return words.length > 0 && leadingMarkers(words) === words.length;
}

export function trailingMarkers(words: readonly string[]): number {
  const start = words.findIndex((_, index) => markerRun(words.slice(index)));
  return start < 0 ? 0 : words.length - start;
}

export function markerEdges(words: readonly string[]): MarkerEdges {
  const lead = leadingMarkers(words);
  const rest = words.slice(lead);
  const trail = trailingMarkers(rest);
  return [words.slice(0, lead), rest.slice(0, rest.length - trail), rest.slice(rest.length - trail)];
}

// A word that only introduces more items at `at`, with a joiner said right before it («а ще»), or a label word («розмір», D64): how many words it takes, 0
// for none.
function itemLeadAt(words: readonly string[], at: number): number {
  if (ITEM_LEAD_WORDS.has(words[at] ?? "") || LABEL_WORDS.has(words[at] ?? "")) return 1;
  return ADD_JOINERS.has(words[at] ?? "") && ITEM_LEAD_WORDS.has(words[at + 1] ?? "") ? 2 : 0;
}

// «24 кольори»: a colour word after a number says how many colours, a value (D66).
function colourCount(words: readonly string[], end: number): boolean {
  return COLOUR_COUNTS.has(words[end - 1] ?? "") && valueOf("quantity", words[end - 2] ?? "") !== null;
}

// D82: «смартфон садари четыре плюс», «айфон 15 плюс»: «плюс» after a number at the end of a span is the model's name («Plus»), not more items.
const PLUS_WORDS: ReadonlySet<string> = new Set(["плюс"]);

function itemLeadBefore(words: readonly string[], end: number): number {
  if (LABEL_WORDS.has(words[end - 1] ?? "")) return colourCount(words, end) ? 0 : 1;
  if (!ITEM_LEAD_WORDS.has(words[end - 1] ?? "")) return 0;
  if (PLUS_WORDS.has(words[end - 1] ?? "") && end > 1 && valueOf("quantity", words[end - 2] ?? "") !== null) return 0;
  return end > 1 && ADD_JOINERS.has(words[end - 2] ?? "") ? 2 : 1;
}

// How many words at the start of `words` are marker runs and words that only introduce more items («а ні давай ще додамо»).
function leadingFiller(words: readonly string[]): number {
  let at = 0;
  for (;;) {
    const past = at + leadingMarkers(words.slice(at));
    const next = past + itemLeadAt(words, past);
    if (next === at) return at;
    at = next;
  }
}

function trailingFiller(words: readonly string[]): number {
  let end = words.length;
  for (;;) {
    const cut = end - trailingMarkers(words.slice(0, end));
    const next = cut - itemLeadBefore(words, cut);
    if (next === end) return words.length - end;
    end = next;
  }
}

// The edges of a span the model tagged that are no item: marker runs, the words that only introduce more items (D60, «давай ще додамо», «плюс») and label
// words («42 розмір», «розмір M», D64).
// They go to the gap, where `repaired` and `additive` read them.
export function spanEdges(words: readonly string[]): MarkerEdges {
  const lead = leadingFiller(words);
  const rest = words.slice(lead);
  const trail = trailingFiller(rest);
  return [words.slice(0, lead), rest.slice(0, rest.length - trail), rest.slice(rest.length - trail)];
}

function slotOf(piece: LinePiece): LineKind {
  return piece.kind === "product" && piece.mayBeVariant ? "variant" : piece.kind;
}

function valueSlot(piece: LinePiece | undefined): boolean {
  return piece !== undefined && slotOf(piece) !== "product";
}

function joined(piece: LinePiece): boolean {
  return piece.gap.some((word) => CONNECTORS.has(word));
}

function sameName(left: string, right: string): boolean {
  const said = left.split(" ");
  const again = right.split(" ");
  return said.length === again.length && said.every((word, index) => wordMatch(word, again[index] ?? ""));
}

function sameSlot(said: LinePiece, repair: LinePiece): boolean {
  const slot = slotOf(repair);
  return slot === slotOf(said) && (slot !== "product" || sameName(said.text, repair.text));
}

function strengthOf(gap: readonly string[]): Strength {
  if (gap.length === 1 && LONE_MARKERS.has(gap[0] ?? "")) return "lone";
  return leadingMarkers(gap, CONDITIONAL) === gap.length && gap.some((word) => !LONE_MARKERS.has(word)) ? "back" : "strong";
}

function lastProduct(kept: readonly LinePiece[]): LinePiece | undefined {
  return kept.findLast((piece) => slotOf(piece) === "product");
}

// «чотири трубочки ні п'ять трубочок»: the unit after a lone «ні» names the product said right before it again (same stem, `wordMatch`).
function repeatsProduct(kept: readonly LinePiece[], unit: readonly LinePiece[]): boolean {
  const said = kept.slice(-LONGEST_UNIT).findLast((piece) => slotOf(piece) === "product");
  const again = unit.find((piece) => slotOf(piece) === "product");
  return said !== undefined && again !== undefined && sameName(said.text, again.text);
}

function repairs(kept: readonly LinePiece[], unit: readonly LinePiece[]): boolean {
  const previous = kept.at(-1);
  const [piece] = unit;
  if (previous === undefined || piece === undefined || !markerRun(piece.gap)) return false;
  const strength = strengthOf(piece.gap);
  if (strength === "back") return slotOf(previous) === slotOf(piece);
  return strength === "strong" || (valueSlot(previous) && valueSlot(piece)) || repeatsProduct(kept, unit);
}

function parallel(kept: readonly LinePiece[], unit: readonly LinePiece[]): boolean {
  const said = kept.slice(-unit.length);
  return said.length === unit.length && ![...said.slice(1), ...unit.slice(1)].some(joined) && said.every((piece, index) => sameSlot(piece, unit[index] ?? piece));
}

// «горішки 7 ой 8 трубочки 10»: the product after the value has a value of its own, so the value repairs the line before the marker.
function ownValue(value: LinePiece, after: LinePiece | undefined): boolean {
  return after !== undefined && slotOf(after) === slotOf(value) && !joined(after);
}

// A value that a new product follows is that product's, a unit that replaces the line before the marker (D59): after a halt («круасан 2 штуки а ні
// стоп дві штуки еклера 4 круасана»), or where the new product has no value of its own after it («круасан 2 штуки а ні дві штуки еклера»).
function startsLine(kept: readonly LinePiece[], piece: LinePiece, next: LinePiece | undefined, after: LinePiece | undefined): boolean {
  const said = lastProduct(kept);
  if (said === undefined || next === undefined || slotOf(next) !== "product" || joined(next) || sameName(said.text, next.text)) return false;
  return piece.gap.some((word) => HALTS.has(word)) || !ownValue(piece, after);
}

function bare(piece: LinePiece, next: LinePiece | undefined): boolean {
  return valueSlot(piece) && (next === undefined || next.kind !== "product" || joined(next));
}

// The unit after a strong marker (or a product after «хоча ні») that names a new product replaces the line before the marker: `linesBySide` drops that line.
function replacesLine(kept: readonly LinePiece[], piece: LinePiece, strength: Strength): boolean {
  return lastProduct(kept) !== undefined && (strength === "strong" || (strength === "back" && slotOf(piece) === "product"));
}

function inPlaceOf(piece: LinePiece, said: LinePiece | undefined): LinePiece {
  return { ...piece, gap: said?.gap ?? [], ...(said?.replaces === true ? { replaces: true } : {}) };
}

// A removed piece that started a replacing line hands the mark to the piece that takes its place.
function removeAt(kept: LinePiece[], index: number): void {
  const [removed] = kept.splice(index, 1);
  const heir = kept[index];
  if (removed?.replaces === true && heir !== undefined) kept[index] = { ...heir, replaces: true };
}

function claimedByEarlier(kept: readonly LinePiece[], target: number): boolean {
  const before = kept[target - 1];
  const piece = kept[target];
  return before !== undefined && piece !== undefined && before.kind === "product" && !joined(piece) && piece.replaces !== true;
}

// «3 макаронси ваніль ой ні 5» (D60): a bare quantity also looks past the flavours said after the line's product.
function productAt(kept: readonly LinePiece[], piece: LinePiece): number {
  let at = kept.length - 1;
  if (slotOf(piece) !== "quantity") return at;
  while (at > 0 && slotOf(kept[at] ?? piece) === "variant" && !joined(kept[at] ?? piece)) at -= 1;
  return at < kept.length - 1 && slotOf(kept[at] ?? piece) === "product" ? at : kept.length - 1;
}

function repairedLine(kept: LinePiece[], piece: LinePiece): void {
  const at = productAt(kept, piece);
  const product = kept[at];
  if (product === undefined || slotOf(product) !== "product" || joined(product)) return;
  const target = at - 1;
  const said = kept[target];
  if (said !== undefined && slotOf(said) === slotOf(piece) && !claimedByEarlier(kept, target)) {
    removeAt(kept, target);
    return;
  }
  const [adjective, ...name] = product.text.split(" ");
  if (slotOf(piece) === "variant" && name.length > 0 && adjectiveLike(adjective ?? "")) kept[at] = { ...product, text: name.join(" ") };
}

// `after` (the words said after the last item) starts with a back-marker run (D61): «2 круасани, а ні стоп, 3, хоча ні, правильно», whose last value the
// recogniser lost. The callers also check that no item word follows the run.
export function takesBack(after: readonly string[]): boolean {
  const words = withoutHedges(after);
  const run = leadingMarkers(words);
  return run > 0 && strengthOf(words.slice(0, run)) === "back";
}

// The parts of a line the pieces make: a run of attributes is one.
function partCount(pieces: readonly LinePiece[]): number {
  return pieces.filter((piece, at) => slotOf(piece) !== "variant" || at === 0 || slotOf(pieces[at - 1] ?? piece) !== "variant").length;
}

// The unit a repair at `from` said ends the list: the pieces after it continue its line (no joiner, no marker) and fit in one line.
function endsList(pieces: readonly LinePiece[], from: number): boolean {
  return partCount(pieces.slice(from)) <= LONGEST_LINE && !pieces.slice(from + 1).some((piece) => joined(piece) || markerWords(piece.gap).size > 0);
}

// The most words a value the speaker took back may have when the model left it untagged («сороковий», «по двісті п'ятдесят мілілітрів»).
const LONGEST_DROPPED = 4;

// «кеди конверс чорні сороковий ой ні сорок другий», «маску для сну рожеву а ні стоп сіру», «клеми на три контакти а нет на п'ять контактів» (D72): the
// value the speaker took back is no span (the model tags only the value that stands), so the gap before the new value holds it and the marker. The
// new value stays in its line in its place: the taken-back words and the marker leave its gap, a preposition after the marker stays. Values only (a
// quantity or an attr); a new product after a marker still replaces its line (D59), and taken-back words with a joiner among them stay a gap.
function withoutTakenBack(piece: LinePiece, index: number): LinePiece {
  if (index === 0 || piece.kind === "product" || piece.mayBeVariant) return piece;
  const words = withoutHedges(piece.gap);
  const markers = markerWords(words);
  for (let at = 1; at <= Math.min(LONGEST_DROPPED, words.length - 1); at++) {
    const dropped = words.slice(0, at);
    if (markers.has(at - 1) || dropped.some((word) => CONNECTORS.has(word) || REPAIR_WORDS.has(word) || HALTS.has(word) || ITEM_LEAD_WORDS.has(word))) return piece;
    const run = leadingMarkers(words.slice(at));
    if (run === 0) continue;
    const rest = words.slice(at + run);
    if (rest.length === 0 || (rest.length === 1 && PREPOSITIONS.has(rest[0] ?? ""))) return { ...piece, gap: rest, retaken: true };
  }
  return piece;
}

// Chained repairs run left to right, so the last value wins, an earlier one said again too («три еклери ой чотири ой ні п'ять», «… хоча ні, все-таки медовий»).
// `takeBack` (a back-marker run after the last item, `takesBack`) undoes the last repair when its unit ends the list: the value said before it stands.
export function repaired(given: readonly LinePiece[], takeBack = false): LinePiece[] {
  const pieces = given.map(withoutTakenBack);
  const kept: LinePiece[] = [];
  let undo: readonly [before: readonly LinePiece[], from: number] | null = null;
  for (const [index, piece] of pieces.entries()) {
    if (!repairs(kept, pieces.slice(index, index + LONGEST_UNIT))) {
      kept.push(piece);
      continue;
    }
    undo = [[...kept], index];
    const strength = strengthOf(piece.gap);
    const next = pieces[index + 1];
    const sizes = strength === "strong" && startsLine(kept, piece, next, pieces[index + 2]) ? [LONGEST_UNIT] : [LONGEST_UNIT, 1];
    const length = sizes.find((size) => index + size <= pieces.length && parallel(kept, pieces.slice(index, index + size)));
    if (length !== undefined) {
      const [first] = kept.splice(kept.length - length, length);
      kept.push(inPlaceOf(piece, first));
      continue;
    }
    if (!bare(piece, next)) {
      kept.push(replacesLine(kept, piece, strength) ? { ...piece, replaces: true } : piece);
      continue;
    }
    repairedLine(kept, piece);
    kept.push({ ...piece, gap: [] });
  }
  return takeBack && undo !== null && endsList(pieces, undo[1]) ? [...undo[0]] : kept;
}

// A hedge («напевно», «десь») is no word of an item list (D60); «ну» stays in the gap as the joiner it also is.
export function withoutHedges(words: readonly string[]): string[] {
  return words.filter((word) => !HEDGE_WORDS.has(word) || CONNECTORS.has(word));
}

// «ще», «ще додай», «і додай напевно ще», ru «ещё добавь», «и ещё» (D60): the gap is an additive cue, an optional joiner first, hedges left out. A marker
// run before the cue gives way to it (D61): «4 круасана а ні ще додай 5» adds.
export function additive(gap: readonly string[]): boolean {
  const said = gap.filter((word) => !HEDGE_WORDS.has(word));
  const words = said.slice(leadingMarkers(said));
  return CUES.has((ADD_JOINERS.has(words[0] ?? "") ? words.slice(1) : words).join(" "));
}

// A line as `linesBySide` read it: `stray` is a quantity no line took, which repeats the product of the line before (D51); `cued` follows an additive cue.
export interface SaidLine {
  readonly line: OrderLine;
  readonly stray: boolean;
  readonly cued: boolean;
}

// A quantity as a number and the unit said with it, piece units left out; `null` for no unit at all, which a line without a quantity has: it is one piece
// (spec §7). A word that is neither a number nor a unit makes the quantity none («пару», «пачку», «з половиною»).
type Count = readonly [value: number, unit: string | null];

function countOf(quantity: string | undefined): Count | null {
  if (quantity === undefined) return [1, null];
  const words = quantity.split(" ");
  const value = valueOf("quantity", quantity);
  if (typeof value !== "number" || !words.every((word) => UNITS.has(word) || valueOf("quantity", word) !== null)) return null;
  return [value, words.filter((word) => UNITS.has(word) && !PIECE_UNITS.has(word)).join(" ")];
}

// A quantity that only counts pieces or pairs, as a whole number («дві пари» 2, «3» 3); null for a weight, a pack or a word that is no number.
export function pieceCount(quantity: string): number | null {
  const count = countOf(quantity);
  return count !== null && !count[1] && Number.isInteger(count[0]) ? count[0] : null;
}

// «2 кг» and «3» are «5 кг»; «2 кг» and «3 коробки» are no sum, nor one piece and «5 пачки».
function sameUnit(first: string | null, second: string | null): boolean {
  if (first === null || second === null) return !first && !second;
  return !first || !second || sameName(first, second);
}

function total(said: OrderLine, more: OrderLine): string | null {
  const first = countOf(said.quantity);
  const second = countOf(more.quantity);
  if (first === null || second === null || !sameUnit(first[1], second[1])) return null;
  const unit = first[1] || second[1];
  const sum = canonicalNumber(cleanNumber(first[0] + second[0]) ?? 0);
  return unit ? `${sum} ${unit}` : sum;
}

// The same attribute words, in any order, by word form: «чорна 44» and «44 чорну» (D65, the D60 key on the attr set); none matches only none.
export function sameAttrs(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const unmatched = [...right];
  return left.every((attr) => {
    const at = unmatched.findIndex((other) => sameName(attr, other));
    return at >= 0 && unmatched.splice(at, 1).length === 1;
  });
}

// One order has one line per product and attribute set (D60, D65): a line of the same product (by stem) and attrs as an earlier one adds its quantity to
// that line, which keeps its place; a stray quantity adds only after an additive cue, to the line said right before it («4 круасана ще додай 5»), else it
// stays a line of its own that the card asks about (spec §7 rule 4). A quantity that is no number keeps both lines. Runs after `repaired`, so a repair
// still replaces («3 макаронси ой ні 5» is 5).
export function summed(said: readonly SaidLine[]): OrderLine[] {
  const lines: OrderLine[] = [];
  let last = -1;
  for (const { line, stray, cued } of said) {
    const target = stray ? (cued ? last : -1) : lines.findLastIndex((earlier) => sameName(earlier.product, line.product) && sameAttrs(earlier.attrs, line.attrs));
    const earlier = lines[target];
    const quantity = earlier === undefined ? null : total(earlier, line);
    if (earlier === undefined || quantity === null) {
      last = lines.push(stray ? { ...line, asks: true } : line) - 1;
      continue;
    }
    lines[target] = { ...earlier, quantity, said: [...earlier.said, ...line.said] };
    last = target;
  }
  return lines;
}
