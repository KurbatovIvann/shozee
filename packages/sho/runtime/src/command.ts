import { ORDER_LINES, intentOfAction, isV3, listHeadOf, listItemType, type ActionName, type Bundle, type IntentKind, type ParamType } from "./bundle.ts";
import { segment, type CompiledContext } from "./catalogue.ts";
import { confidenceOf } from "./confidence.ts";
import type { RecordList } from "./context.ts";
import type { Resolved } from "./customers.ts";
import { DEICTICS, RECORD_REFS, REF_PHRASES } from "./lexicon/references.ts";
import { PAYMENT_CONTROL_STEMS, REST_STEMS, type PaymentMethodKey } from "./lexicon/roles.ts";
import { FROM_WORDS } from "./lexicon/values.ts";
import type { OrderLine } from "./lines.ts";
import { UNITS, UNIT_KEYS } from "./lexicon/units.ts";
import { valueOf, wordNumberAt } from "./numbers.ts";
import { isLines, isNames, type ParamValue, type Params } from "./params.ts";
import type { Inference } from "./pipeline.ts";
import { customerRef, listRef, productRef, resolveItem, resolveVariant, type Confidences, type Lookup, type ParamNeed, type Outcome } from "./resolve.ts";
import type { RoleAsk } from "./roles.ts";
import type { Attr, Confirmation, CommandV2, EnumParam, Effect, Need, OrderItem, Param, PaymentPart, Quantity, Ref, SpanParam, SpanValue } from "./result.ts";
import type { TaggedSpan } from "./spans.ts";
import {
  addressValue,
  bankValue,
  branchValue,
  cityValue,
  countValue,
  emailValue,
  fitsPostomat,
  ibanValid,
  measureValue,
  methodOf,
  moneyAmount,
  percentAmount,
  taxIdValid,
  ttnValue,
  whenValue,
  type MeasureValue,
  type Money,
} from "./values.ts";
import type { Now } from "./when.ts";
import type { Unsupported } from "./stockless.ts";
import { withSuggestions } from "./suggest.ts";
import { createAsUpdate, groupAsUpdate } from "./createAsUpdate.ts";
import { RENAME_LEADS, RENAME_VERBS } from "./lexicon/customers.ts";

// A command as the pipeline decided it (spans, the names the customer matcher found, references to earlier commands), built into a `CommandV2`: every
// param typed and resolved against the context (`resolve.ts`), what the card still needs, the effect and the confirmation it takes (D65).

export interface Decision {
  readonly text: string;
  readonly action: ActionName;
  readonly params: Params;
  readonly resolved: Resolved;
  readonly refPrevious: Readonly<Record<string, number>>;
  readonly catalogued: boolean;
  // The action head's probabilities the confidence is read from: calibrated by the bundle's temperature (D87) when the pipeline builds the decision.
  readonly actionProbabilities: readonly number[];
  // The model's spans of the passes the command came from, for per-span confidence.
  readonly spans: readonly TaggedSpan[];
  // v3 (D69): the aux heads' labels, and the moment `when` spans are read against (Europe/Kyiv).
  readonly aux?: Readonly<Record<string, string>>;
  readonly now?: Now | null;
  // v3 (D70): spans no cue word gave a param (`roles.ts`): the card asks which param they fill.
  readonly asks?: readonly RoleAsk[];
  // D72: what the shop cannot do that the command asked (`stockless.ts`): a need on that path.
  readonly unsupported?: Unsupported;
  // D72: the numbers the raw text wrote with a percent sign («знижкою 10%»), which the normalised text lost (`percentMarks`).
  readonly percents?: readonly string[];
  // D82: clock times said («о 9:00») whose pieces were no params (`decode.ts` `clockFree`): a non-blocking `ignored` need each.
  readonly ignored?: readonly string[];
  // D79: refs a pronoun or a deictic word takes from the previous command the host passed (`pronouns.ts`), by param.
  readonly fromPrevious?: Readonly<Record<string, Param>>;
  readonly debug?: Inference;
}

// What the intent catalogue requires of each action's params (`intent_labels_uk.json` of the bundle): every `required` param, and one of `oneOf`.
export interface Requirement {
  readonly required: readonly string[];
  readonly oneOf: readonly string[];
}

export type Requirements = Readonly<Record<string, Requirement>>;

// D78: a refinement (`read-modifier`, `ui.refine`) reads as the read it refines.
const EFFECTS: Readonly<Record<IntentKind, Effect>> = { nav: "navigate", read: "read", write: "write", high: "destructive", ui: "ui", none: "none", "read-modifier": "read" };
const CONFIRMATIONS: Readonly<Record<IntentKind, Confirmation>> = { nav: "none", read: "none", write: "card", high: "strong", ui: "none", none: "none", "read-modifier": "none" };
const REF_LISTS: Readonly<Record<string, RecordList>> = { group: "groups", price_list: "priceLists", counterparty: "counterparties" };
const CUSTOMER = "customer";
const PRODUCT = "product";
const VARIANT = "variant";
const RESTORE = /\.restore/;
const COD = "cod";
const CITY = "city";
const BRANCH = "branch";
const BRANCH_LEAD = "на";
const MEASURE = "measure";
const PERCENT = "percent";
const CUE_REACH = 4;
const SPLIT = "split";
const PAYMENT_METHOD = "payment_method";
const AMOUNT = "amount";
const MIXED = "mixed";
const IBAN = "iban";
const EDRPOU = "edrpou";
const ATTR = "attr";
const REST_REACH = 2;
const SHIPMENT = "delivery.createShipment";
const NEW_SHIPMENT = "nav.deliveries_new";
// A bare «створи ТТН» (intents v3 §4.2, spec §3 rule 2): a shipment that says nothing but the carrier is the new-waybill form.
const BARE_SHIPMENT_PARAMS: ReadonlySet<string> = new Set(["carrier"]);
// D70: what a v3 write command cannot be confirmed without: one of these params (the recipient of a waybill is an order, a customer or a phone).
const V3_ONE_OF: Readonly<Record<string, readonly string[]>> = { [SHIPMENT]: ["order_number", "customer", "phone"] };
// D72: the `when` params that say when a past event happened (`accounting.addIncome` / `addExpense` `on`, `payments.markPaid` `paid`).
const PAST_WHEN: ReadonlySet<string> = new Set(["on", "paid"]);
// The v3 value types the builder reads (intents v3 §5.1, D69, D70); every other span keeps the v2 reader (`numbers.ts` `valueOf`).
const V3_KINDS: ReadonlySet<string> = new Set(["money", "count", "percent", "when", "ttn", "branch", "measure", "city", "bank_name", "email", "address"]);
const DEICTIC_PHRASES = DEICTICS.toSorted((left, right) => right[0].length - left[0].length);
const REFERENCE_WORDS: readonly string[] = [...REF_PHRASES, ...[...RECORD_REFS.values()].flatMap(([, phrases]) => phrases)].toSorted((left, right) => right.length - left.length);

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// The lowest mean tag probability of the model spans that share a word with the text.
function spanConfidences(spans: readonly TaggedSpan[]): Confidences {
  return (text) => {
    const words = new Set(wordsOf(text));
    const scores = spans.filter((span) => wordsOf(span.text).some((word) => words.has(word))).map((span) => span.score);
    return scores.length ? Math.min(...scores) : undefined;
  };
}

// The words that took a record from an earlier command («туди», «йому»), the longest found in the command's text.
function referenceText(text: string): string {
  const words = ` ${text} `;
  return REFERENCE_WORDS.find((phrase) => words.includes(` ${phrase} `)) ?? "";
}

// v3 (D70): the words that took this param from an earlier command, among the words that can point at it (a person's pronouns for a customer, «його»,
// «це замовлення» for an order); none when nothing was said for it (an order a shipment follows in one breath).
function v3ReferenceText(text: string, name: string, type: ParamType | undefined): string {
  const words = ` ${text} `;
  const phrases = type === CUSTOMER ? REF_PHRASES : [...RECORD_REFS.values()].filter(([param]) => param === name).flatMap(([, found]) => found);
  return phrases.toSorted((left, right) => right.length - left.length).find((phrase) => words.includes(` ${phrase} `)) ?? "";
}

function prefixed(prefix: string, needs: readonly ParamNeed[]): Need[] {
  return needs.map((need) => ({ ...need, path: need.path ? `${prefix}.${need.path}` : prefix }));
}

function refNeeds(path: string, ref: Ref): Need[] {
  return ref.status === "ambiguous" || ref.status === "unknown" ? [{ path, reason: ref.status, blocking: true }] : [];
}

function sameUnit(left: Quantity, right: Quantity): boolean {
  return left.unit === null || right.unit === null || left.unit === right.unit;
}

function lineKey(item: OrderItem): string | null {
  const { product, variant } = item;
  if (product.status !== "resolved" || typeof product.id !== "string") return null;
  if (variant.status === "none") return `${product.id} `;
  return variant.status === "resolved" && variant.id !== undefined ? `${product.id} ${variant.id}` : null;
}

function sum(first: Quantity, second: Quantity): Quantity {
  return { text: null, said: [...first.said, ...second.said], value: (first.value ?? 0) + (second.value ?? 0), unit: first.unit ?? second.unit, unitText: first.unitText ?? second.unitText };
}

// No two items of one command name the same product and variant (§4.3): a later line that resolves to the ids of an earlier one adds its quantity to it
// («чорна 44» and «44 чорного кольору»); when the quantities do not add up (another unit, a word that is no number), it stays with a blocking
// `duplicate_line`, as Shozee refuses duplicate lines.
function mergedById(items: readonly Outcome<OrderItem>[]): Outcome<OrderItem>[] {
  const kept: Outcome<OrderItem>[] = [];
  for (const item of items) {
    const key = lineKey(item.value);
    const at = key === null ? -1 : kept.findIndex((earlier) => lineKey(earlier.value) === key);
    const earlier = kept[at];
    if (earlier === undefined) {
      kept.push(item);
      continue;
    }
    const first = earlier.value.quantity;
    const second = item.value.quantity;
    if (first.value === null || second.value === null || !sameUnit(first, second)) kept.push({ ...item, needs: [...item.needs, { path: "", reason: "duplicate_line", blocking: true }] });
    else kept[at] = { ...earlier, value: { ...earlier.value, quantity: sum(first, second) } };
  }
  return kept;
}

// A catalogue `variant` span's attr words: the vocabulary's values it holds, other words kept together («червоний 44» → «червоний», «44»).
function attrWords(text: string, context: CompiledContext | null): string[] {
  if (context === null || context.empty) return [text];
  const attrs: string[] = [];
  let other: string[] = [];
  const flush = () => {
    if (other.length) attrs.push(other.join(" "));
    other = [];
  };
  for (const [kind, piece] of segment(wordsOf(text), context)) {
    if (kind === "gap") flush();
    else if (kind === "variant") {
      flush();
      attrs.push(piece);
    } else other.push(piece);
  }
  flush();
  return attrs.length ? attrs : [text];
}

// D82 (E11): «пісок 2 т»: a line with no quantity whose one attr is a number of tonnes is that many tonnes of it; a product is not packed by the tonne
// (grams, kilos and litres stay a size: «кава 250 г», «шампунь 250 мл»).
function tonnesCounted(line: OrderLine): OrderLine {
  if (line.quantity !== undefined) return line;
  const tonnes = line.attrs.filter((attr) => {
    const [number, unit, ...rest] = attr.split(" ");
    return number !== undefined && unit !== undefined && !rest.length && valueOf("quantity", number) !== null && UNIT_KEYS.get(unit) === "t";
  });
  const [quantity] = tonnes;
  return tonnes.length === 1 && quantity !== undefined ? { ...line, attrs: line.attrs.filter((attr) => attr !== quantity), quantity, said: [quantity] } : line;
}

interface Built {
  readonly param: Param;
  readonly needs: readonly Need[];
}

function built(param: Param, needs: readonly Need[] = []): Built {
  return { param, needs };
}

// The words before a span's text in the utterance, nearest last.
function wordsBefore(utterance: string, text: string): string[] {
  const at = ` ${utterance} `.indexOf(` ${text} `);
  return at < 0 ? [] : wordsOf(utterance.slice(0, at)).map((word) => word.toLowerCase());
}

// The method of a part of a mixed payment: the word right after it («500 готівкою»), else the word right before it («готівкою 500»).
// D73: the first place the text is said with a method next to it, so a part said again inside the total («чек на тисячу чотириста, тисячу карткою») has
// its own.
function methodNear(utterance: string, text: string): PaymentMethodKey | null {
  const padded = ` ${utterance} `;
  for (let at = padded.indexOf(` ${text} `); at >= 0; at = padded.indexOf(` ${text} `, at + 1)) {
    const after = wordsOf(padded.slice(at + text.length + 2))[0]?.toLowerCase();
    const before = wordsOf(padded.slice(0, at)).at(-1)?.toLowerCase();
    const method = (after === undefined ? null : methodOf(after)) ?? (before === undefined ? null : methodOf(before));
    if (method !== null) return method;
  }
  return null;
}

interface Read {
  readonly value?: SpanValue;
  readonly needs: readonly Need[];
}

function invalid(path: string): Read {
  return { needs: [{ path, reason: "invalid_value", blocking: true }] };
}

function read(value: SpanValue | null, path: string): Read {
  return value === null ? invalid(path) : { value, needs: [] };
}

function resolvedName(resolved: Resolved, name: string, index: number | null): string | null {
  const known = Object.hasOwn(resolved, name) ? resolved[name] : undefined;
  if (index === null) return typeof known === "string" ? known : null;
  return typeof known === "string" || known === undefined ? null : (known[index] ?? null);
}

class ParamBuilder {
  private readonly bundle: Bundle;
  private readonly decision: Decision;
  private readonly context: CompiledContext | null;
  private readonly lookup: Lookup;
  private readonly confidences: Confidences;

  constructor(bundle: Bundle, decision: Decision, context: CompiledContext | null) {
    this.bundle = bundle;
    this.decision = decision;
    this.context = context;
    this.lookup = { records: context?.records ?? null, customers: context?.customers ?? null, restoring: RESTORE.test(decision.action), text: decision.text };
    this.confidences = spanConfidences(decision.spans);
  }

  private partial(list: RecordList): boolean {
    return this.lookup.records?.shop.partial.has(list) === true;
  }

  private customer(name: string, text: string, index: number | null): Ref {
    return customerRef(text, resolvedName(this.decision.resolved, name, index), this.lookup, this.partial("customers"), this.confidences(text));
  }

  private items(lines: readonly OrderLine[]): Built {
    // D82: an attr said twice in one line («чорне 42 чорне 42») is one attr of it, and a word of the product said twice in a row («сукня коктейльна
    // коктейльна») is said once.
    const once = lines.map((line) => {
      const words = line.product.split(" ");
      const product = words.filter((word, index) => word !== words[index - 1]).join(" ");
      const attrs = new Set(line.attrs).size < line.attrs.length ? [...new Set(line.attrs)] : line.attrs;
      return tonnesCounted(product === line.product && attrs === line.attrs ? line : { ...line, product, attrs });
    });
    const items = mergedById(once.map((line) => resolveItem(line, this.lookup, this.confidences)));
    return built(items.map((item) => item.value), items.flatMap((item, index) => prefixed(`items[${index}]`, item.needs)));
  }

  private variant(text: string): Built {
    const product = this.decision.params[PRODUCT];
    const found = typeof product === "string" ? productRef(product, this.lookup) : null;
    const index = found !== null && found.ref.status === "resolved" ? (found.indices[0] ?? null) : null;
    const choice = resolveVariant(attrWords(text, this.context), index, this.lookup, this.confidences);
    const confidence = this.confidences(text);
    return built({ text, ...choice.variant, attrs: choice.attrs, ...(confidence === undefined ? {} : { confidence }) }, prefixed(VARIANT, choice.needs));
  }

  // The kind of the model span a param's text came from, among the kinds its type takes (a union: `discount` is a percent or money).
  private kindOf(text: string, kinds: readonly string[]): string {
    if (kinds.includes(PERCENT) && (this.decision.percents ?? []).includes(text.split(" ").at(-1) ?? "")) return PERCENT;
    const tagged = this.decision.spans.find((span) => span.text === text && kinds.includes(span.kind))?.kind;
    if (tagged !== undefined) return tagged;
    return kinds.includes(PERCENT) && /%|відсот|процент/.test(text) ? PERCENT : (kinds.find((kind) => kind !== PERCENT) ?? kinds[0] ?? "");
  }

  // A v3 span read by its kind (D69); null drops a money span that says no number (intents v3 §5.1).
  private v3Value(name: string, kind: string, text: string, path: string): Read | null {
    const now = this.decision.now ?? null;
    switch (kind) {
      case "money": {
        const money = moneyAmount(text);
        if (money === null) return null;
        if (name === SPLIT) {
          const method = methodNear(this.decision.text, text);
          return { value: method === null ? money : { ...money, method }, needs: [] };
        }
        if (name !== COD) return { value: money, needs: [] };
        const control = wordsBefore(this.decision.text, text).slice(-CUE_REACH).some((word) => PAYMENT_CONTROL_STEMS.some((stem) => word.startsWith(stem)));
        return { value: { ...money, mode: control ? "payment_control" : "cod" }, needs: [] };
      }
      case "count":
        return read(countValue(text), path);
      case "percent":
        return read(percentAmount(text), path);
      case "when":
        return now === null ? { needs: [] } : read(whenValue(text, now, PAST_WHEN.has(name)), path);
      case "ttn":
        return read(ttnValue(text), path);
      case "branch": {
        const branch = branchValue(text);
        if (branch === null) return invalid(path);
        const blocking = intentOfAction(this.bundle, this.decision.action).intent.kind === "write";
        return { value: branch, needs: branch.number === null ? [{ path, reason: "missing", blocking }] : [] };
      }
      case "measure":
        return read(measureValue(text), path);
      case "city": {
        const city = cityValue(text);
        if (name !== CITY || listItemType(this.bundle, this.typeOf(name)) !== CITY) return { value: city, needs: [] };
        const before = wordsBefore(this.decision.text, text).at(-1) ?? "";
        return { value: { ...city, role: FROM_WORDS.has(before) ? "from" : "to" }, needs: [] };
      }
      case "bank_name": {
        const bank = bankValue(text);
        return bank === null ? { needs: [] } : { value: bank, needs: [] };
      }
      case "email":
        return read(emailValue(text), path);
      case "address":
        return { value: addressValue(text), needs: [] };
      default:
        return null;
    }
  }

  private typeOf(name: string): ParamType {
    const { intent } = intentOfAction(this.bundle, this.decision.action);
    return Object.hasOwn(intent.params, name) ? (intent.params[name] ?? "") : "";
  }

  private span(name: string, kind: string, text: string, path: string): Built | null {
    const found = this.v3Value(name, kind, text, path);
    if (found === null) return null;
    const confidence = this.confidences(text);
    return built({ text, ...(found.value === undefined ? {} : { value: found.value }), ...(confidence === undefined ? {} : { confidence }) }, found.needs);
  }

  // A span the card asks the role of (D70), read by its kind, in no param.
  asked(kind: string, text: string): SpanParam | null {
    const found = this.span("", kind, text, "");
    return found === null ? null : (found.param as SpanParam);
  }

  // An IBAN or an ЄДРПОУ / РНОКПП in a v3 bundle (D70): the v2 value, and an `invalid_value` need when the checksum or the control digit fails (a digit
  // the recogniser misheard), so the card asks before a payment or a counterparty is saved.
  private taxCode(name: string, type: string, text: string): Built {
    const value = valueOf(type, text);
    const valid = typeof value === "string" && (type === IBAN ? ibanValid(value) : taxIdValid(value));
    const confidence = this.confidences(text);
    const param: SpanParam = { text, ...(value === null ? {} : { value }), ...(confidence === undefined ? {} : { confidence }) };
    return built(param, valid ? [] : [{ path: name, reason: "invalid_value", blocking: true }]);
  }

  private productIndex(): number | null {
    const product = this.decision.params[PRODUCT];
    const found = typeof product === "string" ? productRef(product, this.lookup) : null;
    return found !== null && found.ref.status === "resolved" ? (found.indices[0] ?? null) : null;
  }

  // v3 attrs (D70): a catalogue or price-list `variant` said as attrs resolves to one variant as a v2 `variant` param does; the attrs of `stock.get`,
  // `stock.set` and `analytics.summary` are matched against the product's variants (each attr with the variants it names), and an attr no variant
  // has is a non-blocking `unknown_attr`: the stock of several variants is their sum, so nothing there is ambiguous.
  private attrs(name: string, texts: readonly string[]): Built {
    const choice = resolveVariant(texts, this.productIndex(), this.lookup, this.confidences);
    if (name === VARIANT) {
      const text = texts.join(" ");
      const confidence = this.confidences(text);
      const needs = choice.needs.map((need) => ({ ...need, path: need.path === VARIANT ? "" : need.path }));
      return built({ text, ...choice.variant, attrs: choice.attrs, ...(confidence === undefined ? {} : { confidence }) }, prefixed(VARIANT, needs));
    }
    const unknown = choice.attrs.flatMap((attr, index): Need[] => (attr.variantIds !== null && !attr.variantIds.length ? [{ path: `${name}[${index}]`, reason: "unknown_attr", blocking: false }] : []));
    return built(choice.attrs, unknown);
  }

  // A v3 list of values (`money_list`, `measure_list`, `city_list`): one span param each.
  private spanList(name: string, kind: string, texts: readonly string[]): Built {
    const items = texts.flatMap((text, index) => {
      const found = this.span(name, kind, text, `${name}[${index}]`);
      return found === null ? [] : [found];
    });
    return built(items.map((item) => item.param as SpanParam), items.flatMap((item) => item.needs));
  }

  param(name: string, type: ParamType | undefined, value: ParamValue): Built | null {
    if (type === ORDER_LINES && isLines(value)) return this.items(value);
    // v3.1 (D75): a list of enum values is the values themselves.
    if (type !== undefined && listHeadOf(this.bundle, type) !== undefined && isNames(value)) return built(value);
    const v3 = isV3(this.bundle) && type !== undefined;
    const item = type === undefined ? undefined : listItemType(this.bundle, type);
    if (v3 && isNames(value) && item !== undefined && V3_KINDS.has(item)) return this.spanList(name, item, value);
    if (v3 && isNames(value) && item === ATTR) return this.attrs(name, value);
    if (v3 && typeof value === "string" && (type === IBAN || type === EDRPOU)) return this.taxCode(name, type, value);
    if (v3 && typeof value === "string") {
      const members = Object.hasOwn(this.bundle.unions, type) ? (this.bundle.unions[type] ?? []) : [type];
      const kind = members.length > 1 ? this.kindOf(value, members) : type;
      if (V3_KINDS.has(kind)) return this.span(name, kind, value, name);
    }
    if (isNames(value)) {
      const refs = value.map((text, index) => (type !== undefined && listItemType(this.bundle, type) === CUSTOMER ? this.customer(name, text, index) : { text, status: "unchecked" as const }));
      return built(refs, refs.flatMap((ref, index) => refNeeds(`${name}[${index}]`, ref)));
    }
    if (typeof value !== "string") return built([]);
    if (type !== undefined && this.bundle.enumTypes.has(type)) return built({ value });
    if (type === CUSTOMER) {
      const ref = this.customer(name, value, null);
      return built(ref, refNeeds(name, ref));
    }
    if (type === PRODUCT) {
      const ref = productRef(value, this.lookup, this.confidences(value)).ref;
      return built(ref, refNeeds(name, ref));
    }
    if (type === VARIANT) return this.variant(value);
    const list = type === undefined ? undefined : REF_LISTS[type];
    if (list !== undefined) {
      const ref = listRef(value, this.lookup.records?.lists[list] ?? null, this.partial(list), this.lookup, this.confidences(value));
      return built(ref, refNeeds(name, ref));
    }
    const found = valueOf(type ?? "", value);
    const confidence = this.confidences(value);
    return built({ text: value, ...(found === null ? {} : { value: found }), ...(confidence === undefined ? {} : { confidence }) });
  }
}

function spanValue(param: Param | undefined): SpanValue | undefined {
  return param !== undefined && !Array.isArray(param) && "text" in param && !("status" in param) && !("attrs" in param) ? (param as SpanParam).value : undefined;
}

// A parcel for a parcel locker that is heavier than 20 kg or larger than 40 × 30 × 60 cm (intents v3 §4.2): shown on the card, not blocking.
function postomatNeeds(params: Readonly<Record<string, Param>>): Need[] {
  const branch = spanValue(params[BRANCH]);
  const measures = params[MEASURE];
  if (typeof branch !== "object" || !("kind" in branch) || branch.kind !== "postomat" || !Array.isArray(measures)) return [];
  return (measures as readonly SpanParam[]).flatMap((measure, index) => {
    const value = measure.value;
    const fits = typeof value !== "object" || !("grams" in value || "cm" in value) || fitsPostomat(value as MeasureValue);
    return fits ? [] : [{ path: `${MEASURE}[${index}]`, reason: "postomat_limit" as const, blocking: false }];
  });
}

function missing(requirement: Requirement | undefined, present: (name: string) => boolean): Need[] {
  if (requirement === undefined) return [];
  const needs: Need[] = requirement.required.filter((name) => !present(name)).map((path) => ({ path, reason: "missing", blocking: true }));
  if (requirement.oneOf.length && !requirement.oneOf.some(present)) needs.push({ path: requirement.oneOf.join("|"), reason: "missing", blocking: true });
  return needs;
}

// Every span confidence a param holds.
function scores(value: Param | Attr | Quantity): number[] {
  if (Array.isArray(value)) return value.flatMap((item: OrderItem | Ref | string) => (typeof item === "string" ? [] : "product" in item ? [scores(item.product), scores(item.quantity), ...item.attrs.map(scores)].flat() : scores(item)));
  const own = "confidence" in value && typeof value.confidence === "number" ? [value.confidence] : [];
  return "attrs" in value ? [...own, ...value.attrs.flatMap(scores)] : own;
}

// D70 (intents v3 §6d): the params of the intent that a deictic word points at («їй» the customer, «цю ТТН» the waybill), with the words said; a word
// inside a model span is part of that span, not a pointer.
export function deictics(bundle: Bundle, decision: Decision): Map<string, string> {
  const types = intentOfAction(bundle, decision.action).intent.params;
  const customer = Object.entries(types).find(([, type]) => type === CUSTOMER)?.[0];
  const text = ` ${decision.text} `;
  const found = new Map<string, string>();
  for (const [phrase, target] of DEICTIC_PHRASES) {
    if (!text.includes(` ${phrase} `) || decision.spans.some((span) => ` ${span.text} `.includes(` ${phrase} `))) continue;
    const name = target === CUSTOMER ? customer : Object.hasOwn(types, target) ? target : undefined;
    if (name !== undefined && !found.has(name)) found.set(name, phrase);
  }
  return found;
}

// Words after a number that say it is no branch: a unit («на 2 кіло»), an hour («на 4 години», «на 4 вечора»).
const NOT_BRANCH_AFTER: ReadonlySet<string> = new Set(["годину", "години", "годин", "час", "часа", "часов", "ранку", "утра", "вечора", "вечера", "дня", "числа", "штук", "штуки"]);
const MOST_BRANCH = 99_999;

// «відправ в Одесу на 4» (D71): a number right after the city of a shipment or an estimate, alone or after «на», that no span holds, with no branch said,
// is the branch.
function bareBranch(bundle: Bundle, decision: Decision): Decision {
  const types = intentOfAction(bundle, decision.action).intent.params;
  const city = decision.params[CITY];
  const cityText = typeof city === "string" ? city : isNames(city) ? city.at(-1) : undefined;
  if (types[BRANCH] !== BRANCH || decision.params[BRANCH] !== undefined || cityText === undefined) return decision;
  const words = decision.text.split(" ");
  const said = cityText.split(" ");
  const at = words.findIndex((_, start) => said.every((word, offset) => words[start + offset] === word));
  if (at < 0) return decision;
  const from = at + said.length;
  const start = words[from] === BRANCH_LEAD ? from + 1 : from;
  const digits = /^[0-9]{1,5}$/.test(words[start] ?? "") ? ([Number(words[start]), start + 1] as const) : wordNumberAt(words, start);
  if (digits === null || !Number.isInteger(digits[0]) || digits[0] < 1 || digits[0] > MOST_BRANCH) return decision;
  const next = words[digits[1]];
  if (next !== undefined && (NOT_BRANCH_AFTER.has(next) || UNITS.has(next) || UNIT_KEYS.has(next))) return decision;
  const offset = words.slice(0, from).join(" ").length + (from > 0 ? 1 : 0);
  const text = words.slice(from, digits[1]).join(" ");
  if (decision.spans.some((span) => span.start < offset + text.length && span.end > offset)) return decision;
  return { ...decision, params: { ...decision.params, [BRANCH]: text } };
}

const UPDATE_CUSTOMER = "customers.updateCustomer";
const RENAME_TO = "rename_to";

// Where the words `said` start in `words`, from `from` on, or -1.
function wordsAt(words: readonly string[], said: readonly string[], from: number): number {
  for (let start = from; start + said.length <= words.length; start++) if (said.length && said.every((word, offset) => words[start + offset] === word)) return start;
  return -1;
}

// D85 (F2 of the dictation v5 report): «надю переименуй надежда кравец»: the model tagged the new name as a second customer span, and a param takes one
// span (`bestSpans`), so the new name was lost. In a `customers.updateCustomer` with no `rename_to`, of exactly two customer spans the one that is not
// the customer, said after it and right after a rename verb («переименуй», «перейменуй», «переіменуй», `RENAME_VERBS`), or right after «на / в» with a
// rename verb before it («перейменуй олега на …»), is the new name.
function renamedCustomer(bundle: Bundle, decision: Decision): Decision {
  const customer = decision.params[CUSTOMER];
  if (decision.action !== UPDATE_CUSTOMER || typeof customer !== "string" || decision.params[RENAME_TO] !== undefined) return decision;
  if (!Object.hasOwn(intentOfAction(bundle, decision.action).intent.params, RENAME_TO)) return decision;
  const named = decision.spans.filter((span) => span.kind === CUSTOMER);
  const other = named.find((span) => span.text !== customer);
  if (named.length !== 2 || other === undefined || !named.some((span) => span.text === customer)) return decision;
  const words = wordsOf(decision.text);
  const own = wordsOf(customer);
  const first = wordsAt(words, own, 0);
  const at = first < 0 ? -1 : wordsAt(words, wordsOf(other.text), first + own.length);
  if (at < 0) return decision;
  const lead = words[at - 1] ?? "";
  const renamed = RENAME_VERBS.has(lead) || (RENAME_LEADS.has(lead) && words.slice(0, at - 1).some((word) => RENAME_VERBS.has(word)));
  return renamed ? { ...decision, params: { ...decision.params, [RENAME_TO]: other.text } } : decision;
}

// D70: a v3 command before its params are built. A waybill that says nothing but the carrier, points at no record and takes none from an earlier
// command is the new-waybill form (`nav.deliveries_new`, spec §3 rule 2), when the bundle has it.
function v3Decision(bundle: Bundle, given: Decision, pointed: ReadonlyMap<string, string>): Decision {
  const decision = bareBranch(bundle, given);
  const bare = decision.action === SHIPMENT && Object.keys(decision.params).every((name) => BARE_SHIPMENT_PARAMS.has(name)) && !Object.keys(decision.refPrevious).length;
  if (!bare || pointed.size || decision.asks?.length || !Object.hasOwn(bundle.intents, NEW_SHIPMENT)) return decision;
  return { ...decision, action: intentOfAction(bundle, NEW_SHIPMENT).action, params: {}, asks: [] };
}

function moneyOf(param: Param | undefined): Money | null {
  const value = spanValue(param);
  return typeof value === "object" && value !== null && "minor" in value ? value : null;
}

// D70: a mixed payment's parts, each with the method said next to it, and «решта карткою» as the rest: the total less the parts when the total is said
// in the parts' currency, else a part with no amount.
function paymentParts(text: string, params: Readonly<Record<string, Param>>): PaymentPart[] | null {
  const split = params[SPLIT];
  if (!Array.isArray(split) || !split.length) return null;
  const parts: PaymentPart[] = (split as readonly SpanParam[]).flatMap((part) => {
    const money = moneyOf(part);
    if (money === null) return [];
    const method = typeof part.value === "object" && part.value !== null && "method" in part.value ? (part.value.method ?? null) : null;
    return [{ method, minor: money.minor, currency: money.currency }];
  });
  if (!parts.length) return null;
  const words = wordsOf(text.toLowerCase());
  const restAt = words.findIndex((word) => REST_STEMS.some((stem) => word.startsWith(stem)));
  const restMethod = restAt < 0 ? null : (words.slice(restAt + 1, restAt + 1 + REST_REACH).map(methodOf).find((method) => method !== null) ?? null);
  if (restAt < 0) return parts;
  const total = moneyOf(params[AMOUNT]);
  const [first] = parts;
  const same = total !== null && first !== undefined && parts.every((part) => part.currency === total.currency);
  const left = same ? total.minor - parts.reduce((sum, part) => sum + (part.minor ?? 0), 0) : null;
  return [...parts, { method: restMethod, minor: left !== null && left > 0 ? left : null, currency: first?.currency ?? "UAH", rest: true }];
}

export function commandV2(bundle: Bundle, given: Decision, context: CompiledContext | null, requirements: Requirements = {}): CommandV2 {
  const v3 = isV3(bundle);
  // D84: a create of a customer the list knows, addressed in the dative, is its update; D85: a group edit whose group is a customer the list knows is
  // that customer's update (`createAsUpdate.ts`, the two rules that change the action).
  const asUpdate = createAsUpdate(bundle, given, context);
  const asCustomer = groupAsUpdate(bundle, asUpdate.decision, context);
  // D85: the new name the model tagged as a second customer after a rename verb.
  const renamed = renamedCustomer(bundle, asCustomer.decision);
  const pointed = v3 ? deictics(bundle, renamed) : new Map<string, string>();
  const decision = v3 ? v3Decision(bundle, renamed, pointed) : renamed;
  const { intent } = intentOfAction(bundle, decision.action);
  const builder = new ParamBuilder(bundle, decision, context);
  const params: Record<string, Param> = {};
  const needs: Need[] = [];
  for (const [name, value] of Object.entries(decision.params)) {
    const found = builder.param(name, Object.hasOwn(intent.params, name) ? intent.params[name] : undefined, value);
    if (found === null) continue;
    params[name] = found.param;
    needs.push(...found.needs);
  }
  needs.push(...postomatNeeds(params));
  for (const [name, command] of Object.entries(decision.refPrevious)) {
    if (Object.hasOwn(params, name)) continue;
    params[name] = { text: v3 ? v3ReferenceText(decision.text, name, intent.params[name]) : referenceText(decision.text), status: "previous", command };
  }
  if (v3) {
    for (const [name, ref] of Object.entries(decision.fromPrevious ?? {})) if (Object.hasOwn(intent.params, name) && !Object.hasOwn(params, name)) params[name] = ref;
    for (const [name, phrase] of pointed) if (Object.hasOwn(intent.params, name) && !Object.hasOwn(params, name)) params[name] = { text: phrase, status: "context" };
    for (const ask of decision.asks ?? []) {
      const span = builder.asked(ask.span.kind, ask.span.text);
      needs.push({ path: ask.names.join("|"), reason: "ambiguous_role", blocking: true, ...(span === null ? {} : { span }) });
    }
    const parts = paymentParts(decision.text, params);
    const method = params[PAYMENT_METHOD] as EnumParam | undefined;
    if (parts !== null && Object.hasOwn(intent.params, PAYMENT_METHOD) && (method === undefined || method.value === MIXED)) params[PAYMENT_METHOD] = { value: MIXED, parts };
    const oneOf = V3_ONE_OF[decision.action];
    if (oneOf !== undefined) needs.unshift(...missing({ required: [], oneOf }, (name) => Object.hasOwn(params, name)));
  }
  needs.unshift(...missing(requirements[decision.action], (name) => Object.hasOwn(params, name)));
  if (decision.unsupported !== undefined) needs.push({ path: decision.unsupported.path, reason: "unsupported", blocking: decision.unsupported.blocking });
  for (const text of decision.ignored ?? []) needs.push({ path: "text", reason: "ignored", blocking: false, span: { text } });
  if (asUpdate.said !== null) needs.push({ path: "action", reason: "read_as_update", blocking: false, span: { text: asUpdate.said } });
  if (asCustomer.said !== null) needs.push({ path: "action", reason: "read_as_customer_update", blocking: false, span: { text: asCustomer.said } });
  const spans = Object.values(params).flatMap(scores);
  const command: CommandV2 = {
    text: decision.text,
    action: decision.action,
    kind: intent.kind,
    effect: EFFECTS[intent.kind],
    confirm: CONFIRMATIONS[intent.kind],
    // D78: `nearest` and `suggest` on what the context does not know.
    params: withSuggestions(bundle, decision.action, params, context),
    needs,
    ready: !needs.some((need) => need.blocking),
    refPrevious: decision.refPrevious,
    catalogued: decision.catalogued,
    confidence: { ...confidenceOf(decision.actionProbabilities), spans: spans.length ? Math.min(...spans) : 1 },
    ...(decision.aux?.["domain"] === undefined ? {} : { domain: decision.aux["domain"] }),
    ...(decision.aux?.["verb"] === undefined ? {} : { verb: decision.aux["verb"] }),
  };
  return decision.debug === undefined ? command : { ...command, debug: decision.debug };
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

// D72: a read that lists records («покажи замовлення», «покажи групи») lists all of them when nothing narrows it, so its filters are no requirement: the
// catalogues give its filters `one_of` (and a few a `required` search text) for the training data, not for the card. A read of one record («покажи
// клієнта»), a search and every write keep theirs.
function listing(action: string, kind: unknown): boolean {
  return kind === "read" && /^list/.test(action.split(".")[1] ?? "");
}

// The requirements of an intent catalogue: the bundle's `intent_labels_uk.json` (`intents.<action>.params[]` with `name`, `required`, `one_of`), or the
// v3 catalogue `data/voice2/catalogue_v3.json` (`intents.<action>.params.<name>.required`, `intents.<action>.one_of: [[...names]]`, D72), whose `kind`
// says which intents list records (`listing`). Anything else in it is ignored, and a file of another shape gives none.
export function parseRequirements(json: unknown): Requirements {
  const intents: unknown = field(json, "intents");
  if (typeof intents !== "object" || intents === null) return {};
  return Object.fromEntries(Object.entries(intents).map(([action, intent]: [string, unknown]) => {
    if (listing(action, field(intent, "kind"))) return [action, { required: [], oneOf: [] }];
    const params: unknown = field(intent, "params");
    if (typeof params === "object" && params !== null && !Array.isArray(params)) {
      const groups: unknown = field(intent, "one_of");
      const oneOf = Array.isArray(groups) ? groups.flatMap((group: unknown) => (Array.isArray(group) ? group.filter((name: unknown): name is string => typeof name === "string") : [])) : [];
      return [action, { required: Object.entries(params).flatMap(([name, param]: [string, unknown]) => (field(param, "required") === true ? [name] : [])), oneOf }];
    }
    const list: unknown[] = Array.isArray(params) ? params : [];
    const named = (flag: string) => list.flatMap((param: unknown) => {
      const name = field(param, "name");
      return typeof name === "string" && field(param, flag) === true ? [name] : [];
    });
    return [action, { required: named("required"), oneOf: named("one_of") }];
  }));
}
