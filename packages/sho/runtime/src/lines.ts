import { attrApart, attrCut } from "./attrKinds.ts";
import type { Bundle } from "./bundle.ts";
import { CONNECTORS, LABEL_WORDS, LINE_WITH } from "./lexicon/catalogue.ts";
import { valueOf } from "./numbers.ts";
import { UNITS } from "./lexicon/units.ts";
import { additive, pieceCount, repaired, spanEdges, summed, takesBack, withoutHedges, type SaidLine } from "./repair.ts";
import type { TaggedSpan } from "./spans.ts";
import { adjectiveLike } from "./words.ts";

// One order line as read from the utterance: the product said, its attribute words in the order said (a flavour, a size, a colour: any number, D65),
// and the quantity. `quantity` is the span, «1» for one of a count spread over lines (`spreadCounts`), or a D60 sum in digits; `said` holds every
// quantity span that went into it; `asks` marks a quantity no line took, which repeats the product before so that the card asks (D51, spec §7 rule 4).
export interface OrderLine {
  readonly product: string;
  readonly attrs: readonly string[];
  readonly quantity?: string;
  readonly said: readonly string[];
  readonly asks?: true;
}

export type LineKind = "product" | "quantity" | "variant";

// What the model-only pairing reads of a bundle: its line fields, and its label set (`catalogue`: "v3" keeps side-by-side products apart, D72).
export type LineBundle = Pick<Bundle, "lineFields"> & { readonly catalogue?: string | null };

export interface LinePiece {
  readonly kind: LineKind;
  readonly text: string;
  readonly gap: readonly string[];
  readonly mayBeVariant: boolean;
  // The line this piece starts replaces the line before it: a repair marker said before a new product (D59, `repaired`).
  readonly replaces?: boolean;
  // An attr the catalogue does not know, which the model tagged (the catalogue pass only).
  readonly unknown?: boolean;
  // A value said in place of one the speaker took back, which the model left untagged (D72, `repair.ts` `withoutTakenBack`).
  readonly retaken?: true;
}

interface MergedSpan {
  readonly kind: string;
  readonly start: number;
  end: number;
  text: string;
  score: number;
}

type Side = "before" | "after";
type Cost = readonly [orphans: number, lines: number, wrapped: number, bare: number, reversed: number, switches: number, split: number];

interface Chunk {
  readonly pieces: readonly LinePiece[];
  readonly kinds: readonly LineKind[];
}

interface Reading {
  readonly cost: Cost;
  readonly chunks: readonly Chunk[];
}

// Line shapes, each run of attribute words («чорна 44», «256 гб чорний») read as one `variant` (`shapeOf`), and the side the quantity is on. Attrs on
// both sides of the product («червону сукню коктейльну 42») make one line only where no other reading has as few lines (the `wrapped` cost, D65).
const SHAPES: ReadonlyMap<string, Side | null> = new Map([
  ["quantity product", "before"],
  ["quantity product variant", "before"],
  ["quantity variant product", "before"],
  ["quantity variant product variant", "before"],
  ["quantity variant", "before"],
  ["product quantity", "after"],
  ["product variant quantity", "after"],
  // «шпаклівка ceresit три мішки по 25 кг»: a measure said after the count with «по» / «на» (D72, `allowed`).
  ["product quantity variant", "after"],
  ["variant product quantity", "after"],
  ["variant product variant quantity", "after"],
  ["variant quantity", "after"],
  ["product", null],
  ["product variant", null],
  ["variant product", null],
  ["variant product variant", null],
  ["variant", null],
]);
const WRAPPED: ReadonlySet<string> = new Set(["quantity variant product variant", "variant product variant quantity", "variant product variant"]);
const NO_COST: Cost = [0, 0, 0, 0, 0, 0, 0];
// A line holds at most this many attribute words, besides its quantity and product.
export const MOST_ATTRS = 4;
const LONGEST_LINE = 2 + MOST_ATTRS;

// The shape of a line's kinds, a run of attrs read as one; null when the line holds more attrs than a line may.
export function shapeOf(kinds: readonly LineKind[]): string | null {
  if (kinds.filter((kind) => kind === "variant").length > MOST_ATTRS) return null;
  return kinds.filter((kind, index) => kind !== "variant" || kinds[index - 1] !== "variant").join(" ");
}

function shapeIs(chunk: Chunk, shape: string): boolean {
  return shapeOf(chunk.kinds) === shape;
}

function sideOf(kinds: readonly LineKind[]): Side | null {
  return SHAPES.get(shapeOf(kinds) ?? "") ?? null;
}

function joined(piece: LinePiece): boolean {
  return piece.gap.some((word) => CONNECTORS.has(word));
}

function replacing(piece: LinePiece): boolean {
  return piece.replaces === true;
}

function boundTo(piece: LinePiece | undefined, kind: LineKind | undefined): boolean {
  return piece !== undefined && piece.kind === "variant" && kind === "product" && piece.gap.length === 1 && LINE_WITH.has(piece.gap[0] ?? "");
}

function readingsOf(pieces: readonly LinePiece[]): LineKind[][] {
  const plain = pieces.map((piece) => piece.kind);
  const second = pieces[1];
  const varied = second !== undefined && second.mayBeVariant && plain[0] === "product" && (pieces.length === 2 || plain[2] === "quantity");
  return varied ? [plain.map((kind, index) => (index === 1 ? "variant" : kind)), plain] : [plain];
}

function reversedVariant(chunk: Chunk): LinePiece | null {
  const variant = chunk.kinds.indexOf("variant");
  const product = chunk.kinds.indexOf("product");
  return variant >= 0 && product > variant ? (chunk.pieces[variant] ?? null) : null;
}

const NUMBER_LED = /^[0-9]/;
// D72: prepositions that join two attrs of one line («по», «на», «у» / «в», «для», «під» / «под», «з» / «с» once), and those that put a measure after the
// count («по», «на»).
const RUN_PREPOSITIONS: ReadonlySet<string> = new Set(["по", "на", "у", "в", "для", "під", "под", "з", "із", "зі", "с", "со"]);
const MEASURE_PREPOSITIONS: ReadonlySet<string> = new Set(["по", "на"]);

// Where a run of attrs cannot go on (D65): it holds attrs said one right after the other, label words aside («чорні розмір 44»; «торт медовий почекай
// ягідний»), two numbers in a row are a list of values («розміри 40 41 і 42», «50 мл 100 мл»), and it starts with an attr the catalogue knows («два
// макарон the фісташка»: «the» is none). D72: one preposition between two attrs goes on with the run («кефір 2,5 по 0,4 літра», «подовжувач п'ять метрів на
// чотири гнізда», «сукня червона для дівчинки»); «з» leads a flavour of its own only when an attr before it in the run had one too («макарони з лимоном з
// малиною» is two lines, «торт медовий з малиною» one).
function breaksRun(piece: LinePiece, before: LinePiece, startsRun: boolean, withBefore: boolean): boolean {
  const words = piece.gap.filter((word) => !LABEL_WORDS.has(word));
  const [only] = words;
  const dimension = only === "на" && bareNumber(piece.text) && bareNumber(before.text);
  const preposition = words.length === 1 && only !== undefined && RUN_PREPOSITIONS.has(only) && !(LINE_WITH.has(only) && withBefore) && !dimension;
  const numbers = NUMBER_LED.test(piece.text) && NUMBER_LED.test(before.text) && !preposition;
  return numbers || (words.length > 0 && !preposition) || (startsRun && before.unknown === true);
}

// A number alone, in digits or words («32», «тридцять два»): «32 на 32» is one size, which a line does not take as two attrs (D72).
function bareNumber(text: string): boolean {
  return text.split(" ").every((word) => /^[0-9]+([.,][0-9]+)?$/.test(word) || (valueOf("quantity", word) !== null && !UNITS.has(word)));
}

function brokenRun(chunk: Chunk): boolean {
  return chunk.pieces.some((piece, at) => {
    const before = chunk.pieces[at - 1];
    const inRun = before !== undefined && chunk.kinds[at] === "variant" && chunk.kinds[at - 1] === "variant";
    if (!inRun) return false;
    let start = at - 1;
    while (start > 0 && chunk.kinds[start - 1] === "variant") start -= 1;
    const withBefore = chunk.pieces.slice(start, at).some((earlier) => earlier.gap.some((word) => LINE_WITH.has(word)));
    return breaksRun(piece, before, chunk.kinds[at - 2] !== "variant", withBefore);
  });
}

// The measure after a count («три мішки по 25 кг», «два ящики на 20 літрів»), or an attr said again after it («хека два кіло філе а ні тушку», D72): the
// only attrs said after the quantity that stay in its line.
function measureAfterCount(chunk: Chunk): boolean {
  if (shapeOf(chunk.kinds) !== "product quantity variant") return true;
  const first = chunk.pieces[chunk.kinds.indexOf("variant")];
  return first !== undefined && ((first.gap.length === 1 && MEASURE_PREPOSITIONS.has(first.gap[0] ?? "")) || (first.retaken === true && first.gap.length === 0));
}

function allowed(chunk: Chunk, following: LinePiece | undefined, seen: boolean): boolean {
  if (!SHAPES.has(shapeOf(chunk.kinds) ?? "") || !(seen || chunk.kinds.includes("product")) || brokenRun(chunk) || !measureAfterCount(chunk)) return false;
  if (chunk.pieces.slice(1).some((piece) => joined(piece) || replacing(piece)) || boundTo(following, chunk.kinds.at(-1))) return false;
  const reversed = reversedVariant(chunk);
  return reversed === null || chunk.kinds[0] === "quantity" || !seen || adjectiveLike(reversed.text);
}

// «… два торта малинових три шоколадних еклери 6 штук»: a «quantity flavour» continuation keeps its adjective when the product after it has a quantity of
// its own right after it (pm-37); the adjective is cut off that product only there.
function ownsQuantity(chunk: Chunk, after: LinePiece | undefined): boolean {
  return shapeIs(chunk, "quantity variant") && after?.kind === "quantity" && !joined(after);
}

function chunkCost(chunk: Chunk, following: LinePiece | undefined, after: LinePiece | undefined, side: Side | null): Cost {
  const own = sideOf(chunk.kinds);
  const reversed = reversedVariant(chunk);
  const last = chunk.pieces.at(-1);
  const cuts = chunk.kinds.at(-1) === "variant" && last !== undefined && adjectiveLike(last.text) && following?.kind === "product" && !joined(following);
  const split = cuts && !ownsQuantity(chunk, after);
  const wrapped = WRAPPED.has(shapeOf(chunk.kinds) ?? "");
  return [0, 1, Number(wrapped), Number(own === null), Number(reversed !== null && !adjectiveLike(reversed.text)), Number(own !== null && side !== null && own !== side), Number(split)];
}

function added(left: Cost, right: Cost): Cost {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2], left[3] + right[3], left[4] + right[4], left[5] + right[5], left[6] + right[6]];
}

function cheaper(left: Cost, right: Cost): boolean {
  const index = left.findIndex((value, at) => value !== right[at]);
  return index >= 0 && (left[index] ?? 0) < (right[index] ?? 0);
}

// «… ще три штуки пасок»: a product right after a stray quantity (no joiner between) is what the quantity counts, so an additive cue before it adds nothing (D60).
function productAfter(chunk: Chunk | undefined): boolean {
  const next = chunk?.pieces[0];
  return next !== undefined && next.kind === "product" && !joined(next);
}

const ONE = "1";
const COUNTED_FLAVOUR = "quantity product variant";
const FLAVOUR = "variant";
const LIST_JOINERS: ReadonlySet<string> = new Set(["і", "й", "та", "и"]);

// «дві пари Adidas Samba 38 і 39», «три пари … 40 41 і 42», «два еклери малиновий і лимонний» (D64): a count of pieces said before a product and its flavour,
// followed by flavour-only lines up to that count, the last after «і» / «й» / «та» / «и», is one of each flavour, so each of those lines counts «1»: a
// count spread over several sizes is a line per size. No list word, no spread («два макарон the фісташка», lh-379). The chunks that take «1».
function spreadCounts(chunks: readonly Chunk[]): ReadonlySet<number> {
  const ones = new Set<number>();
  for (const [index, chunk] of chunks.entries()) {
    if (!shapeIs(chunk, COUNTED_FLAVOUR)) continue;
    const count = pieceCount(chunk.pieces[0]?.text ?? "");
    let after = index + 1;
    for (let next = chunks[after]; next !== undefined && shapeIs(next, FLAVOUR) && !next.pieces.some(replacing); next = chunks[after]) after += 1;
    const listed = chunks[after - 1]?.pieces[0]?.gap.some((word) => LIST_JOINERS.has(word)) === true;
    if (count === null || count < 2 || after - index !== count || !listed) continue;
    for (let at = index; at < after; at++) ones.add(at);
  }
  return ones;
}

function carriedLines(chunks: readonly Chunk[]): OrderLine[] {
  const said: SaidLine[] = [];
  const ones = spreadCounts(chunks);
  for (const [index, chunk] of chunks.entries()) {
    const text = (kind: LineKind): string | undefined => chunk.pieces[chunk.kinds.indexOf(kind)]?.text;
    const product = text("product") ?? said.at(-1)?.line.product;
    if (product === undefined) continue;
    if (chunk.pieces.some(replacing)) said.pop();
    const spoken = text("quantity");
    const attrs = chunk.pieces.filter((_, at) => chunk.kinds[at] === "variant").map((piece) => piece.text);
    const line: OrderLine = ones.has(index) ? { product, attrs, quantity: ONE, said: [] } : { product, attrs, ...(spoken === undefined ? {} : { quantity: spoken }), said: spoken === undefined ? [] : [spoken] };
    said.push({ line, stray: shapeIs(chunk, "quantity"), cued: additive(chunk.pieces[0]?.gap ?? []) && !productAfter(chunks[index + 1]) });
  }
  return summed(said);
}

export interface SideLines {
  readonly lines: OrderLine[];
  readonly orphans: number;
}

// `takeBack`: a back-marker run follows the last piece with no item after it, so the last repair is taken back (`repaired`, D61).
export function linesBySide(given: readonly LinePiece[], takeBack = false): SideLines | null {
  const pieces = repaired(given, takeBack);
  if (!pieces.some((piece) => piece.kind === "product")) return null;
  const memo = new Map<string, Reading>();
  const best = (start: number, side: Side | null, seen: boolean): Reading => {
    if (start === pieces.length) return { cost: NO_COST, chunks: [] };
    const key = `${start} ${side ?? ""} ${seen}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let chosen: Reading | null = null;
    for (let length = Math.min(LONGEST_LINE, pieces.length - start); length > 0; length--) {
      const slice = pieces.slice(start, start + length);
      const following = pieces[start + length];
      for (const kinds of readingsOf(slice)) {
        const chunk: Chunk = { pieces: slice, kinds };
        if (!allowed(chunk, following, seen)) continue;
        const own = sideOf(kinds);
        const rest = best(start + length, own ?? side, seen || kinds.includes("product"));
        const cost = added(chunkCost(chunk, following, pieces[start + length + 1], side), rest.cost);
        if (chosen === null || cheaper(cost, chosen.cost)) chosen = { cost, chunks: [chunk, ...rest.chunks] };
      }
    }
    const stray = pieces[start];
    if (stray !== undefined && stray.kind !== "product") {
      const rest = best(start + 1, side, seen);
      const orphan = added([1, 0, 0, 0, 0, 0, 0], rest.cost);
      const repeated = seen && stray.kind === "quantity" ? [{ pieces: [stray], kinds: [stray.kind] }] : [];
      if (chosen === null || cheaper(orphan, chosen.cost)) chosen = { cost: orphan, chunks: [...repeated, ...rest.chunks] };
    }
    if (chosen === null) chosen = { cost: [pieces.length, 0, 0, 0, 0, 0, 0], chunks: [] };
    memo.set(key, chosen);
    return chosen;
  };
  const reading = best(0, null, false);
  const covered = reading.chunks.reduce((count, chunk) => count + chunk.pieces.length, 0);
  return { lines: carriedLines(reading.chunks), orphans: pieces.length - covered };
}

function withoutRepeats(spans: readonly TaggedSpan[], fields: Bundle["lineFields"]): TaggedSpan[] {
  const kept: TaggedSpan[] = [];
  for (const span of spans) {
    const last = kept.at(-1);
    if (last === undefined || last.start !== span.start || last.end !== span.end) kept.push(span);
    else if (span.kind === fields.product) kept[kept.length - 1] = span;
  }
  return kept;
}

// Item spans of one kind said side by side join (a v2 model tags a long product B- B-). D72: a v3 model begins a new product with B- («торт | брауні з
// арахісом», «тарілки | кекс»), so a v3 bundle joins attrs only; its products stay apart. D78: two attrs of different kinds stay apart («білу | m»,
// «чорних | 42-й», «шоколадний | великий», «256 гб | чорний»: `attrKinds.ts`); one attr the model tagged in pieces still joins («чорний титан», «256 гб»).
export function mergedItems(bundle: LineBundle, spans: readonly TaggedSpan[], utterance: string): TaggedSpan[] {
  const fields = bundle.lineFields;
  const merged: MergedSpan[] = [];
  const productsJoin = bundle.catalogue !== "v3";
  // D82 (v3): one attr span that says two attrs of kinds kept apart is two («бежевий м»: `attrCut`).
  const cut = productsJoin ? spans : spans.flatMap((span) => (span.kind === fields.variant ? cutAttr(span) : [span]));
  for (const span of cut) {
    const previous = merged.length ? merged[merged.length - 1] : undefined;
    const itemKind = (span.kind === fields.product && productsJoin) || span.kind === fields.variant;
    const apart = span.kind === fields.variant && previous !== undefined && attrApart(previous.text, span.text);
    if (previous !== undefined && itemKind && span.kind === previous.kind && utterance.slice(previous.end, span.start) === " " && !apart) {
      previous.end = span.end;
      previous.text = utterance.slice(previous.start, span.end);
      previous.score = (previous.score + span.score) / 2;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function cutAttr(span: TaggedSpan): TaggedSpan[] {
  const found = attrCut(span.text);
  if (found === null) return [span];
  const [before, after] = found;
  const second = span.start + before.length + 1;
  return [{ ...span, end: span.start + before.length, text: before }, { ...span, start: second, text: after }];
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

interface SpanReading {
  readonly pieces: LinePiece[];
  // The words said after the last piece: the edge words of the last item spans and the rest of the utterance.
  readonly after: readonly string[];
}

export function spanPieces(bundle: LineBundle, spans: readonly TaggedSpan[], utterance: string): LinePiece[] {
  return spanReading(bundle, spans, utterance).pieces;
}

function spanReading(bundle: LineBundle, spans: readonly TaggedSpan[], utterance: string): SpanReading {
  const fields = bundle.lineFields;
  const kinds: ReadonlyMap<string, LineKind> = new Map([
    [fields.product, "product"],
    [fields.quantity, "quantity"],
    [fields.variant, "variant"],
  ]);
  const items = withoutRepeats(
    spans.filter((span) => kinds.has(span.kind)),
    fields,
  );
  const pieces: LinePiece[] = [];
  let end: number | null = null;
  let carried: readonly string[] = [];
  for (const span of mergedItems(bundle, items, utterance)) {
    const kind = kinds.get(span.kind);
    if (kind === undefined) continue;
    const between = end === null ? [] : wordsOf(utterance.slice(end, Math.max(end, span.start)));
    end = Math.max(end ?? span.end, span.end);
    const words = wordsOf(span.text);
    const plain = withoutHedges(words);
    const [lead, core, trail] = spanEdges(plain);
    const gap = withoutHedges([...carried, ...between, ...lead]);
    carried = core.length ? trail : gap;
    if (!core.length) continue;
    const [first = "", ...rest] = core;
    const led = kind === "variant" && rest.length > 0 && LINE_WITH.has(first);
    const text = led ? rest.join(" ") : lead.length + trail.length > 0 || plain.length < words.length ? core.join(" ") : span.text;
    pieces.push({ kind, text, gap: led ? [...gap, first] : gap, mayBeVariant: false });
  }
  return { pieces, after: end === null ? [] : [...carried, ...wordsOf(utterance.slice(end))] };
}

// «… 3, хоча ні, правильно» at the end of the list, no number the model left untagged after it (D61).
function takenBack(after: readonly string[]): boolean {
  return takesBack(after) && !after.some((word) => valueOf("quantity", word) !== null);
}

export function pairLines(bundle: LineBundle, spans: readonly TaggedSpan[], utterance: string): OrderLine[] {
  const { pieces, after } = spanReading(bundle, spans, utterance);
  const lines = linesBySide(pieces, takenBack(after))?.lines ?? [];
  const attrs = new Set(lines.flatMap((line) => (line.attrs.length ? [line.attrs.join(" ")] : [])));
  return lines.filter((line) => line.quantity !== undefined || line.attrs.length > 0 || !attrs.has(line.product));
}
