import { ORDER_LINES, intentOfAction, isV3, type ActionName, type Bundle, type EnumKey, type Intent } from "./bundle.ts";
import { CUSTOMER_PARAM, ITEMS_PARAM, catalogueLines, type CompiledContext } from "./catalogue.ts";
import { chosenCustomer, customerFirst, leadingCustomer, outsideCustomer, resolveCustomers, spansOutsideCustomer, surnameAfter, type Resolved, type ResolvedName } from "./customers.ts";
import { ModelError } from "./errors.ts";
import { argmax, softmax } from "./math.ts";
import { DATE_PARSER, isLines, paramValue, paramValues, present, type ParamValue, type Params, type Values } from "./params.ts";
import { assignRoles, type RoleAsk, type Roles } from "./roles.ts";
import { productReading } from "./products.ts";
import { productRef } from "./resolve.ts";
import { percentValue, valueOf } from "./numbers.ts";
import { variantNumbers } from "./variantNumbers.ts";
import { measureTexts } from "./values.ts";
import { stockless, type Unsupported } from "./stockless.ts";
import { listedAction, numberlessOrder, singleGroupMove } from "./rules.ts";
import { namedLists } from "./lists.ts";
import { bestSpans, collectSpans, leadJoined, moneyApart, type BestSpans, type TaggedSpan } from "./spans.ts";
import type { RawMarks } from "./text/normalise.ts";
import type { Offset } from "./tokenizer.ts";
import type { Now } from "./when.ts";
import { LABEL_WORDS, PLURAL_ADJECTIVE_ENDINGS, WITH } from "./lexicon/catalogue.ts";
import { PERCENT_WORDS } from "./lexicon/numbers.ts";
import { DISCOUNT_STEMS } from "./lexicon/roles.ts";
import { adjectiveLike } from "./words.ts";
import { UNIT_KEYS } from "./lexicon/units.ts";
import type { OrderLine } from "./lines.ts";

export type Logits = ArrayLike<number>;

const MEASURE_KIND = "measure";
const MONEY_KIND = "money";
const BASIS_KIND = "basis";
const DOCUMENT_REF_KIND = "document_ref";
const PERCENT_KIND = "percent";
const ORDER_NUMBER_KIND = "order_number";
const WHEN_KIND = "when";
const NO_MARKS: RawMarks = {};
// D82: the name kinds a sentence break of the raw text ends («ТОВ Ранок. Змини ЄДРПОУ …»), as it ends an unknown customer's name (`customers.ts`).
const BROKEN_KINDS: ReadonlySet<string> = new Set(["counterparty", "legal_name"]);

export interface Heads {
  readonly action: Logits;
  readonly tags: readonly Logits[];
  readonly enums: Readonly<Record<EnumKey, Logits>>;
  readonly segment: readonly Logits[] | null;
  // v3: the auxiliary heads by name (`domain`, `verb`), absent for a v2 bundle.
  readonly aux?: Readonly<Record<string, Logits>>;
  // v3.1 (D75): the list heads by key (`tax`), a logit per value; absent before v3.1.
  readonly lists?: Readonly<Record<EnumKey, Logits>>;
}

export interface Reading {
  readonly utterance: string;
  readonly predicted: ActionName;
  readonly action: ActionName;
  readonly intent: Intent;
  readonly params: Params;
  readonly spans: readonly TaggedSpan[];
  readonly best: BestSpans;
  readonly actionProbabilities: readonly number[];
  readonly tagProbabilities: readonly (readonly number[])[];
  // v3: the aux heads' labels (`domain`, `verb`); empty for a v2 bundle (D69).
  readonly aux: Readonly<Record<string, string>>;
  // v3 (D70): spans no cue word gave a param, for the card to ask about (`roles.ts`).
  readonly asks: readonly RoleAsk[];
  // D82: clock times said («о 9:00») whose pieces the model tagged as other params, dropped (`clockFree`).
  readonly ignored?: readonly string[];
}

export interface Resolution {
  readonly action: ActionName;
  readonly intent: Intent;
  readonly params: Params;
  readonly resolved: Resolved;
  readonly catalogued: boolean;
  // D72: what the shop cannot do that the command asked (`stockless.ts`).
  readonly unsupported?: Unsupported;
}

export interface Decoded {
  readonly action: ActionName;
  readonly params: Params;
  readonly values: Values;
  readonly spans: readonly TaggedSpan[];
  readonly best: BestSpans;
  readonly catalogued: boolean;
  readonly resolved: Resolved;
  readonly actionProbabilities: readonly number[];
  readonly tagProbabilities: readonly (readonly number[])[];
  readonly enumProbabilities: Readonly<Record<EnumKey, readonly number[]>>;
  // v3 only (D69): the aux heads' labels.
  readonly aux?: Readonly<Record<string, string>>;
  // v3 only (D70): spans the card asks the role of.
  readonly asks?: readonly RoleAsk[];
  // D72: what the shop cannot do that the command asked.
  readonly unsupported?: Unsupported;
  // D82: clock times said whose pieces were dropped (`clockFree`): a non-blocking `ignored` need each.
  readonly ignored?: readonly string[];
}

function predictedAction(bundle: Bundle, logits: Logits): ActionName {
  const predicted = bundle.actions[argmax(logits)];
  if (predicted === undefined) throw new ModelError("action_width", `action logits have ${logits.length} columns, the bundle has ${bundle.actions.length} actions`);
  return predicted;
}

// The labels of the aux heads (v3 `domain`, `verb`, D69): the runtime decides nothing by them, it reports them.
function auxLabels(bundle: Bundle, heads: Heads): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [name, labels] of Object.entries(bundle.aux)) {
    const logits = heads.aux?.[name];
    const label = logits === undefined || !logits.length ? undefined : labels[argmax(logits)];
    if (label !== undefined) found[name] = label;
  }
  return found;
}

// A param the roles decided (v3, `roles.ts`): its order lines, its span texts (a list) or its one span's text.
function roleValue(roles: Roles, name: string, list: boolean): ParamValue | undefined {
  const lines = roles.lines.get(name);
  if (lines !== undefined) return lines;
  const spans = roles.spans.get(name);
  if (spans === undefined || !spans.length) return undefined;
  return list ? spans.map((span) => span.text) : spans[0]?.text;
}

// D72 (v3): the words a period is read from when no period span says it: the utterance with every other span blanked, so a number or a month that is
// part of a product or a name («айфонів 15 … за вересень» is September, not the 15th; the customer «бебі март» is no March) is no date.
function periodText(utterance: string, spans: readonly TaggedSpan[], rangeSpan: string): string {
  let text = utterance;
  for (const span of spans) if (span.kind !== rangeSpan) text = text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end);
  return text;
}

// D82 (E5): «знижка 10%», «знижку -10%»: a number the raw text wrote with a percent sign (`percentMarks`) that the model tagged as an order number or
// a line's quantity, in an intent that takes a percent (`discount`) and has no percent span, is that percent. The first such span only.
function percentSpans(bundle: Bundle, types: Readonly<Record<string, string>>, spans: readonly TaggedSpan[], percents: ReadonlySet<string>): readonly TaggedSpan[] {
  const takes = Object.values(types).some((type) => (bundle.unions[type] ?? []).includes(PERCENT_KIND));
  if (!takes || !percents.size || spans.some((span) => span.kind === PERCENT_KIND)) return spans;
  const at = spans.findIndex((span) => (span.kind === ORDER_NUMBER_KIND || span.kind === bundle.lineFields.quantity) && !span.text.includes(" ") && percents.has(span.text));
  return at < 0 ? spans : spans.map((span, index) => (index === at ? { ...span, kind: PERCENT_KIND } : span));
}

// D86 (F5): «… чотири рулети меренгові зі знижкою 8%»: a number said right after a discount word («знижкою», «знижка», «скидкой», «дисконтом») and
// followed by a percent (the raw text's «%», or «відсотків» / «процентов» in the span or right after it) that the model tagged as a line's attr or
// quantity or as an order number, in an intent that takes a percent and has no percent span, is that percent (E5, `percentSpans`, run after it, takes a number
// written with «%» when it is a quantity or an order number, cued or not). A span of the discount words alone goes. The product span said right before the discount
// words (only «з / зі / с / со» between), an adjective right after another product span with no count of its own («рулети | меренгові»), is that
// line's attr: the second line was the discount's.
function discountSpans(bundle: Bundle, types: Readonly<Record<string, string>>, spans: readonly TaggedSpan[], utterance: string, percents: ReadonlySet<string>): readonly TaggedSpan[] {
  const takes = Object.values(types).some((type) => (bundle.unions[type] ?? []).includes(PERCENT_KIND));
  if (!takes || spans.some((span) => span.kind === PERCENT_KIND)) return spans;
  const fields = bundle.lineFields;
  const numbered = new Set([ORDER_NUMBER_KIND, fields.quantity, fields.variant]);
  const words = Array.from(utterance.matchAll(/\S+/g), (match) => [match[0], match.index, match.index + match[0].length] as const);
  const cue = (word: string) => DISCOUNT_STEMS.some((stem) => word.startsWith(stem));
  const cueBefore = (span: TaggedSpan) => words.findLast(([, , end]) => end <= span.start);
  const at = spans.findIndex((span) => {
    const said = span.text.split(" ");
    const before = cueBefore(span);
    const after = words.find(([, start]) => start >= span.end);
    const percent = percents.has(span.text) || said.some((word) => PERCENT_WORDS.has(word)) || (after !== undefined && PERCENT_WORDS.has(after[0]));
    return numbered.has(span.kind) && before !== undefined && cue(before[0]) && percent && !PERCENT_WORDS.has(said[0] ?? "") && percentValue(span.text) !== null;
  });
  const target = spans[at];
  const named = target === undefined ? undefined : cueBefore(target);
  if (target === undefined || named === undefined) return spans;
  // Where the discount words start: the cue word and the «з / зі» before it.
  let from = words.indexOf(named);
  while (from > 0 && WITH.has(words[from - 1]?.[0] ?? "")) from -= 1;
  const cueStart = words[from]?.[1] ?? named[1];
  const kept = spans.flatMap((span, index): TaggedSpan[] => {
    if (index === at) return [{ ...span, kind: PERCENT_KIND }];
    const cueOnly = span.start >= cueStart && span.end <= target.start && span.text.split(" ").every((word) => cue(word) || WITH.has(word));
    return cueOnly ? [] : [span];
  });
  const last = kept.findLastIndex((span) => span.end <= cueStart);
  const stray = kept[last];
  const product = kept[last - 1];
  const close = (left: TaggedSpan, right: number) => !utterance.slice(left.end, right).trim();
  if (stray?.kind === fields.product && product?.kind === fields.product && describing(stray.text) && close(stray, cueStart) && close(product, stray.start)) kept[last] = { ...stray, kind: fields.variant };
  return kept;
}

// An adjective of one word, singular or plural («меренговий», «меренгові», «ореховые»).
function describing(text: string): boolean {
  return adjectiveLike(text) || (!text.includes(" ") && PLURAL_ADJECTIVE_ENDINGS.some((ending) => text.endsWith(ending)));
}

// D82 (E6): «відкрий замовлення о 9:00»: the pieces of a clock time the raw text wrote (`clockMarks`, «9 00») that the model tagged as params of their
// own (an order number «9», a sum «00», a document «30») are no params; nor, in a read, a `when` span that is only the time and a word before it («до
// 18 00» of a count). Each clock dropped so is an `ignored` need. The spans kept, and the clock texts dropped.
function clockFree(spans: readonly TaggedSpan[], utterance: string, clocks: readonly string[], read: boolean): readonly [spans: readonly TaggedSpan[], ignored: readonly string[]] {
  if (!clocks.length) return [spans, []];
  const ranges: (readonly [start: number, end: number, text: string])[] = [];
  const padded = ` ${utterance} `;
  // A text given as is keeps the colon («о 9:00»): the clock is found written either way.
  for (const clock of new Set(clocks)) {
    for (const written of [clock, clock.replace(" ", ":")]) for (let at = padded.indexOf(` ${written} `); at >= 0; at = padded.indexOf(` ${written} `, at + 1)) ranges.push([at, at + written.length, written]);
  }
  const dropped = new Set<string>();
  const kept = spans.filter((span) => {
    const range = ranges.find(([start, end]) => (span.kind === WHEN_KIND ? span.start < end && span.end > start : span.start >= start && span.end <= end));
    if (range === undefined) return true;
    if (span.kind === WHEN_KIND && (!read || span.text.split(/[ :]/).length > range[2].split(/[ :]/).length + 1)) return true;
    dropped.add(range[2]);
    return false;
  });
  return [kept, [...dropped]];
}

// D82 (E11): «створи рахунок для 18-го замовлення»: a customer span that is only a number (an ordinal «18-го»), in an intent that takes an order number
// and has no order-number span, is the order.
const NUMBER_ONLY = /^[0-9]{1,7}(?:-\p{L}{1,3})?$/u;

function numberedOrder(types: Readonly<Record<string, string>>, spans: readonly TaggedSpan[]): readonly TaggedSpan[] {
  if (!Object.hasOwn(types, ORDER_NUMBER_KIND) || spans.some((span) => span.kind === ORDER_NUMBER_KIND)) return spans;
  const at = spans.findIndex((span) => span.kind === CUSTOMER_PARAM && NUMBER_ONLY.test(span.text));
  return at < 0 ? spans : spans.map((span, index) => (index === at ? { ...span, kind: ORDER_NUMBER_KIND } : span));
}

// D82 (E11): «8 капкейків два дві трубочки»: two quantity spans side by side that say one number («два» and «дві», «2» and «два») right after a product
// its own count came before are the speaker correcting the word's gender, not two counts: the last one stays. After a product said with no count before
// it («пиріжків з вишнею два дві моккачино») the first is that product's.
function saidAgain(spans: readonly TaggedSpan[], utterance: string, fields: Bundle["lineFields"]): readonly TaggedSpan[] {
  const quantity = fields.quantity;
  const side = (left: TaggedSpan | undefined, right: TaggedSpan | undefined) => left !== undefined && right !== undefined && !utterance.slice(left.end, right.start).trim();
  return spans.filter((span, index) => {
    const next = spans[index + 1];
    const product = spans[index - 1];
    const counted = spans[index - 2];
    if (span.kind !== quantity || next?.kind !== quantity || !side(span, next) || product?.kind !== fields.product || counted?.kind !== quantity || !side(counted, product)) return true;
    const value = valueOf(quantity, span.text);
    return value === null || value !== valueOf(quantity, next.text);
  });
}

// D82: a counterparty or legal name span the recogniser's full stop (or other break) cuts ends there: «тов ранок. змини» is «тов ранок».
function brokenNames(spans: readonly TaggedSpan[], breaks: ReadonlySet<string>): readonly TaggedSpan[] {
  if (!breaks.size) return spans;
  return spans.map((span) => {
    if (!BROKEN_KINDS.has(span.kind)) return span;
    const words = span.text.split(" ");
    const cut = words.findIndex((word, index) => index + 1 < words.length && breaks.has(`${word} ${words[index + 1] ?? ""}`));
    if (cut < 0) return span;
    const text = words.slice(0, cut + 1).join(" ");
    return { ...span, end: span.start + text.length, text };
  });
}

// `breaks` (the raw text's punctuation, `punctuationBreaks`) keep two numbers the recogniser wrote apart with a comma from joining into one span in a v3
// bundle («чек на 900, 500 готівкою», D70); a v2 bundle joins them as before.
export function readCommand(bundle: Bundle, utterance: string, offsets: readonly Offset[], heads: Heads, now: Now | null = null, breaks: ReadonlySet<string> = new Set(), marks: RawMarks = NO_MARKS): Reading {
  const actionProbabilities = softmax(heads.action);
  const predicted = predictedAction(bundle, heads.action);
  const tagProbabilities = heads.tags.map((logits) => softmax(logits));
  const collected = collectSpans(bundle, utterance, offsets, tagProbabilities, isV3(bundle) ? breaks : undefined, isV3(bundle));
  const predictedIntent = intentOfAction(bundle, predicted).intent;
  const types = predictedIntent.params;
  // D73 (v3): two sums said in words in one money span are two spans («тисячу чотириста тисячу»).
  // D79 (v3): a name tagged in two pieces after a lone preposition is one span («для | блогерів»).
  const joined = isV3(bundle) ? leadJoined(moneyApart(collected, MONEY_KIND), utterance) : collected;
  // D82 (v3): a number said with a percent sign is the percent (`percentSpans`; D86: after a discount word, `discountSpans`, first); the pieces of a
  // clock time are no params (`clockFree`).
  const percents = marks.percents ?? new Set<string>();
  const read = isV3(bundle) ? saidAgain(numberedOrder(types, percentSpans(bundle, types, discountSpans(bundle, types, brokenNames(joined, breaks), utterance, percents), percents)), utterance, bundle.lineFields) : joined;
  const [spans, ignored] = isV3(bundle) ? clockFree(read, utterance, marks.clocks ?? [], predictedIntent.kind === "read") : [joined, []];
  const best = bestSpans(spans, utterance);
  const roles = isV3(bundle) ? assignRoles(bundle, types, utterance, spans) : null;
  const spoken: Record<string, ParamValue> = {};
  // A clock's pieces stay out of the period's words too (`joined`: the spans before the clock's were dropped).
  const free = isV3(bundle) ? periodText(utterance, joined, bundle.rangeSpan) : utterance;
  for (const [name, type] of Object.entries(types)) {
    const covered = roles !== null && roles.covered.has(name);
    const said = type === "period" ? free : utterance;
    // D73 (v3): a measure list is read over the words the measure spans start, not only as tagged («кілограми два», «сто сорок на вісімдесят …»).
    const measures = isV3(bundle) && !covered && bundle.listTypes[type] === MEASURE_KIND ? measureTexts(utterance, spans, MEASURE_KIND) : null;
    const value = measures ?? (covered ? roleValue(roles, name, Object.hasOwn(bundle.listTypes, type)) : paramValue(bundle, name, type, said, spans, best, heads.enums, now, heads.lists));
    const month = present(value) || type !== "period" ? null : DATE_PARSER.parseMonth(said);
    // D73 (v3): the base document an intent takes as `basis` (`documents.createFromOrder` «зроби накладну на рахунок 148») is what the model tags a
    // document number, when the intent has no param of that type.
    const base = present(value) || !isV3(bundle) || type !== BASIS_KIND || Object.values(types).includes(DOCUMENT_REF_KIND) ? undefined : best[DOCUMENT_REF_KIND];
    if (base !== undefined) spoken[name] = base;
    else if (present(value)) spoken[name] = value;
    else if (month) spoken[name] = month.value;
  }
  // D58 turns a one-customer `customers.setGroup` into `updateCustomer` for a v2 bundle; the v3 catalogue keeps `setGroup` for one customer too (D72).
  const numbered = numberlessOrder(types, spoken);
  const moved = isV3(bundle) ? { action: predicted, params: numbered } : singleGroupMove(predicted, numbered);
  const params = moved.params;
  const { action, intent } = intentOfAction(bundle, listedAction(moved.action, params));
  return { utterance, predicted, action, intent, params, spans, best, actionProbabilities, tagProbabilities, aux: auxLabels(bundle, heads), asks: action === predicted ? (roles?.asks ?? []) : [], ...(ignored.length ? { ignored } : {}) };
}

export function unresolved(reading: Reading): Resolution {
  return { action: reading.action, intent: reading.intent, params: reading.params, resolved: {}, catalogued: false };
}

// The customer the command takes when the model tagged several (D64, `customers.ts` `chosenCustomer`); none when its only span is part of a product name.
function withChosenCustomer(reading: Reading, context: CompiledContext): Params {
  const params: Record<string, ParamValue> = { ...reading.params };
  const current = params[CUSTOMER_PARAM];
  if (reading.intent.params[CUSTOMER_PARAM] !== CUSTOMER_PARAM || typeof current !== "string") return params;
  const chosen = chosenCustomer(reading.spans, current, reading.utterance, context);
  if (chosen === null) delete params[CUSTOMER_PARAM];
  else params[CUSTOMER_PARAM] = chosen;
  return params;
}

// «смывку цвета», «липовый цвет», «наматрацник розмір 160» (D71): a label word the model's product span holds at its edge («цвета», «розмір») is part of
// the product when the catalogue knows the span with it as a product; the lines took it off (`repair.ts` `spanEdges`), so it goes back.
function labelled(lines: readonly OrderLine[], spans: readonly TaggedSpan[], context: CompiledContext): OrderLine[] {
  return lines.map((line) => {
    const said = line.product.split(" ");
    const span = spans.find((found) => {
      const words = found.text.split(" ");
      const at = words.findIndex((_, start) => said.every((word, offset) => words[start + offset] === word));
      const rest = at < 0 ? [] : [...words.slice(0, at), ...words.slice(at + said.length)];
      return words.length > said.length && rest.length > 0 && rest.every((word) => LABEL_WORDS.has(word));
    });
    return span !== undefined && context.find(span.text.split(" "))?.kind === "product" ? { ...line, product: span.text } : line;
  });
}

function withLabels(params: Params, intent: Intent, spans: readonly TaggedSpan[], context: CompiledContext): Params {
  const out: Record<string, ParamValue> = { ...params };
  for (const [name, type] of Object.entries(intent.params)) {
    const lines = out[name];
    if (type === ORDER_LINES && isLines(lines)) out[name] = labelled(lines, spans, context);
  }
  return out;
}

// D72: the catalogue pass re-reads the whole item range with catalogue names only, so a word the model left out of every span, a quantity, a verb or
// another param can become a product of its own («кравчина бере трековий світильник …» → «бере»), a quantity the vocabulary also lists an attr
// («десять штук», «три метра») and a line split in two. Its lines stand only when they are no worse than the model's own: every product they name is
// one the catalogue resolves or one the model tagged as a product, no model quantity span is one of their attrs, and they are no more lines than the
// model's. Else the model's own lines stand (`pairLines`, each still resolved against the catalogue by `resolveItem`). v3 bundles only: a v2 model's
// own pairing is weaker (its variant head), and its catalogue pass stays as D64-D71 made it.
function worseLines(lines: readonly OrderLine[], own: readonly OrderLine[], spans: readonly TaggedSpan[], fields: Bundle["lineFields"], context: CompiledContext, utterance: string): boolean {
  const quantityKind = fields.quantity;
  // Words the model put in a product or customer span: a catalogue product made of them only re-reads what the model tagged («торта | пиріг з вишнею»
  // of one product span, «павлова» of a customer span the name rules cut), not a verb, a container noun or an attr the model tagged apart («бере»,
  // «бутлів», «фарбою caparol | білої»).
  const named = new Set(spans.filter((span) => span.kind === fields.product || span.kind === CUSTOMER_PARAM).flatMap((span) => span.text.split(" ")));
  const ownProducts = new Set(own.map((line) => line.product));
  const lookup = { records: context.records, customers: context.customers, restoring: false };
  const invented = (line: OrderLine) => !ownProducts.has(line.product) && line.product.split(" ").some((word) => !named.has(word)) && productRef(line.product, lookup).ref.status !== "resolved";
  if (lines.some(invented)) return true;
  const quantities = new Set(spans.filter((span) => span.kind === quantityKind).map((span) => span.text));
  if (lines.some((line) => line.attrs.some((attr) => quantities.has(attr)))) return true;
  // D82 (E11): nor is a model attr a size label follows («41 розмір») or that says a volume («250 мл») one of their quantities: a size, not a count.
  const sizes = new Set(spans.filter((span) => span.kind === fields.variant && sizeSaid(span, utterance)).map((span) => span.text));
  if (lines.some((line) => line.quantity !== undefined && sizes.has(line.quantity))) return true;
  // More lines than the model's: worse when they say a product again the model said once (a line split in two: «… і ще два», an attr the vocabulary
  // lacks), or cut a product the model named and the catalogue resolves; better when they cut a model product the catalogue does not know into
  // pieces it does («торта пиріг з вишнею» → «торта» | «пиріг з вишнею») or add a product the model left in another span («павлова»).
  if (lines.length <= own.length) return false;
  const count = (list: readonly OrderLine[], product: string) => list.filter((line) => line.product === product).length;
  const catalogued = new Set(lines.map((line) => line.product));
  const missing = [...ownProducts].filter((product) => !catalogued.has(product));
  const unnamed = (line: OrderLine) => !ownProducts.has(line.product) && line.product.split(" ").some((word) => !named.has(word));
  // A count spread over sizes («три пари air max 90 розміри 40 41 і 42», D64) is one line of each at «1»: no split.
  const spread = (product: string) => lines.filter((line) => line.product === product).every((line) => line.quantity === "1");
  if (!missing.length) return lines.some((line) => (count(lines, line.product) > Math.max(1, count(own, line.product)) && !spread(line.product)) || unnamed(line));
  const resolves = (product: string) => productRef(product, lookup).ref.status === "resolved";
  // The pieces of an unknown model product: one of them known, and each said with its own count («чотири торта пиріг з вишнею два штуки»; each piece
  // known or counted, which «дві кавової лати круасан» needs, was measured too: 2 more dictation rows, 19 fewer gold-span rows).
  const pieces = (product: string) => lines.filter((line) => ` ${product} `.includes(` ${line.product} `));
  return !missing.every((product) => !resolves(product) && pieces(product).some((line) => resolves(line.product)) && pieces(product).every((line) => line.quantity !== undefined));
}

const VOLUME_KEYS: ReadonlySet<string> = new Set(["ml", "l"]);

// A model attr span that says a size: a size label right after it («41 розмір»), or a volume unit in it («250 мл»).
function sizeSaid(span: TaggedSpan, utterance: string): boolean {
  const next = utterance.slice(span.end).trim().split(" ")[0] ?? "";
  return LABEL_WORDS.has(next) || span.text.split(" ").some((word) => VOLUME_KEYS.has(UNIT_KEYS.get(word) ?? ""));
}

export function resolve(bundle: Pick<Bundle, "intents" | "lineFields" | "listTypes" | "catalogue">, given: Reading, context: CompiledContext, breaks: ReadonlySet<string> = new Set()): Resolution {
  const reading: Reading = { ...given, params: withLabels(given.params, given.intent, given.spans, context) };
  const product = productReading(bundle, reading.action, withChosenCustomer(reading, context), reading.utterance, context);
  const fallback = stockless(bundle, product.action, product.params, context);
  const stocked = fallback === null ? product : { action: intentOfAction(bundle, fallback.action).action, params: fallback.params };
  // D79: a group, price list or counterparty the words name where the model's spans said less (`lists.ts`).
  const read = namedLists(bundle, stocked.action, stocked.params, reading.spans, reading.utterance, context);
  const { intent } = intentOfAction(bundle, read.action);
  const customers = resolveCustomers(intent, reading.utterance, read.params, context, breaks, bundle.listTypes);
  const params = customers.params;
  const resolved: Record<string, ResolvedName> = { ...customers.resolved };
  // An intent with several order-line params (v3 `orders.update`) has its lines by role (`roles.ts`); the catalogue pass reads one list of lines.
  const byRole = Object.values(intent.params).filter((type) => type === ORDER_LINES).length > 1;
  // D73: the words the customer's name holds are no product («тарасу гречку …», «катю лагоду самсунг …»: the name grew over a word the model tagged a
  // product), nor a surname said after a name the list knows without one («олені петренко два торти»).
  let spans = reading.spans;
  const customer = params[CUSTOMER_PARAM];
  const said = params[ITEMS_PARAM];
  if (typeof customer === "string" && isLines(said)) {
    const known = resolved[CUSTOMER_PARAM];
    const grown = typeof known === "string" ? surnameAfter(said, customer, known, reading.utterance, context) : null;
    if (grown !== null) params[CUSTOMER_PARAM] = grown;
    params[ITEMS_PARAM] = outsideCustomer(said, grown ?? customer, reading.utterance);
    const fields = bundle.lineFields;
    spans = spansOutsideCustomer(spans, grown ?? customer, reading.utterance, new Set([fields.product, fields.quantity, fields.variant]));
  }
  const own = params[ITEMS_PARAM];
  const catalogued = context.empty || byRole ? null : catalogueLines(bundle, intent, reading.utterance, spans, params, context, customers.startHint);
  const lines = catalogued !== null && isV3(bundle) && isLines(own) && own.length > 0 && worseLines(catalogued, own, spans, bundle.lineFields, context, reading.utterance) ? null : catalogued;
  if (lines) params[ITEMS_PARAM] = lines;
  const items = params[ITEMS_PARAM];
  const current = params[CUSTOMER_PARAM];
  const first = isLines(items) && Object.hasOwn(intent.params, CUSTOMER_PARAM) ? customerFirst(items, typeof current === "string" ? current : undefined, context) : null;
  if (first !== null) {
    params[ITEMS_PARAM] = first.lines;
    params[CUSTOMER_PARAM] = first.customer;
    resolved[CUSTOMER_PARAM] = first.name;
  }
  const leading = lines !== null && first === null && params[CUSTOMER_PARAM] === undefined && Object.hasOwn(intent.params, CUSTOMER_PARAM) ? leadingCustomer(reading.utterance, lines, context) : null;
  if (leading !== null) {
    params[CUSTOMER_PARAM] = leading[0];
    resolved[CUSTOMER_PARAM] = leading[1];
  }
  const unsupported = fallback === null ? {} : { unsupported: fallback.unsupported };
  // D73: a bare number said right after a line that the product's variants hold is its size, not a count or a sum («шампунь гліс на 400»).
  const sized = variantNumbers(intent, params, reading.utterance, context);
  return { action: read.action, intent, params: first === null && leading === null ? sized : ordered(intent, sized), resolved, catalogued: lines !== null, ...unsupported };
}

// Params in the intent's order, the order lines last as `catalogueLines` appends them.
function ordered(intent: Intent, params: Record<string, ParamValue>): Params {
  const names = [...Object.keys(intent.params).filter((name) => name !== ITEMS_PARAM), ITEMS_PARAM];
  return Object.fromEntries(names.flatMap((name) => {
    const value = params[name];
    return value === undefined ? [] : [[name, value] as const];
  }));
}

export function decoded(reading: Reading, resolution: Resolution, heads: Heads): Decoded {
  const values = paramValues(resolution.intent.params, resolution.params);
  const enumProbabilities = Object.fromEntries(Object.entries(heads.enums).map(([key, logits]) => [key, softmax(logits)]));
  return {
    action: resolution.action,
    params: resolution.params,
    values,
    spans: reading.spans,
    best: reading.best,
    catalogued: resolution.catalogued,
    resolved: resolution.resolved,
    actionProbabilities: reading.actionProbabilities,
    tagProbabilities: reading.tagProbabilities,
    enumProbabilities,
    ...(Object.keys(reading.aux).length ? { aux: reading.aux } : {}),
    ...(reading.asks.length && resolution.action === reading.action ? { asks: reading.asks } : {}),
    ...(resolution.unsupported === undefined ? {} : { unsupported: resolution.unsupported }),
    ...(reading.ignored === undefined ? {} : { ignored: reading.ignored }),
  };
}

export function decode(
  bundle: Bundle,
  utterance: string,
  offsets: readonly Offset[],
  heads: Heads,
  context: CompiledContext | null = null,
  breaks: ReadonlySet<string> = new Set(),
  now: Now | null = null,
  marks: RawMarks = NO_MARKS,
): Decoded {
  const reading = readCommand(bundle, utterance, offsets, heads, now, breaks, marks);
  return decoded(reading, context === null ? unresolved(reading) : resolve(bundle, reading, context, breaks), heads);
}
