import { ORDER_LINES, spanKindsOf, type Bundle, type ParamType } from "./bundle.ts";
import { ASKED_ROLES, ATTRIBUTE_WORDS, BUT_WORDS, LINE_CUES, NEW_AFTER, NOT_WORDS, OLD_AFTER, OLD_BEFORE, PARAM_CUES, REST_STEMS, VERSION_WORDS, type Cue, type LineRole } from "./lexicon/roles.ts";
import { pairLines, type OrderLine } from "./lines.ts";
import type { TaggedSpan } from "./spans.ts";

// Roles (intents v3 §6b, D69). The model tags types, not params: when an intent has several params that take one type (`delivery.createShipment` `cod`
// and `declared` are both `money`; `fiscal.createReceipt` `amount`, `split` and a `discount` that is a percent or money), or a param whose type is a
// union, the words next to each span say which param it fills (`PARAM_CUES`). A span with no cue fills the first of those params, in the intent's
// order, that is still empty, a list param last; a span no param takes is dropped. D70: a span with no cue that cash on delivery or the declared value
// could take fills neither: the card asks (`ASKED_ROLES`, `Roles.asks`). `orders.update` has three order-line params: the verb before each
// line says whether it is added («додай», «ще»), removed («прибери», «без») or changed («зміни … на», «замість»), and a swap («чорну сукню на червону»)
// is a removed line and an added one (`lineRoles`).

export type RoleBundle = Pick<Bundle, "listTypes" | "unions" | "lineFields" | "enumTypes" | "catalogue" | "listEnums">;

export interface Roles {
  // The spans of each param the roles decided, in the utterance's order (a single param takes the first).
  readonly spans: ReadonlyMap<string, readonly TaggedSpan[]>;
  // The order lines of each order-line param (`orders.update`).
  readonly lines: ReadonlyMap<string, readonly OrderLine[]>;
  // Every param the roles decide: one missing from `spans` and `lines` has no value, whatever the spans of its type.
  readonly covered: ReadonlySet<string>;
  // D70: the spans no cue placed among params the card must ask about (`ASKED_ROLES`), with the params it offers.
  readonly asks: readonly RoleAsk[];
}

export interface RoleAsk {
  readonly names: readonly string[];
  readonly span: TaggedSpan;
}

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly tagged: boolean;
}

const WORD = /\S+/g;
const PUNCTUATION = /^[,.;:!?«»"()]+|[,.;:!?«»"()]+$/g;

function wordsOf(utterance: string, spans: readonly TaggedSpan[]): Word[] {
  return Array.from(utterance.matchAll(WORD), (match) => {
    const start = match.index;
    const end = start + match[0].length;
    return { text: match[0].toLowerCase().replace(PUNCTUATION, ""), start, end, tagged: spans.some((span) => span.start < end && start < span.end) };
  });
}

function says(word: Word, stems: readonly string[], whole: readonly string[] = []): boolean {
  return !word.tagged && (whole.includes(word.text) || stems.some((stem) => word.text.startsWith(stem)));
}

// Whether the word at an index cues: a cue word, or the second of a cue pair right after its first (D82: «після оплати»).
function cuesAt(words: readonly Word[], index: number, cue: Cue): boolean {
  const word = words[index];
  if (word === undefined) return false;
  if (says(word, cue.stems, cue.words)) return true;
  const before = words[index - 1];
  return !word.tagged && before !== undefined && !before.tagged && (cue.pairs ?? []).some(([first, second]) => before.text === first && word.text.startsWith(second));
}

// How many words away the nearest cue word of a param is (before the span, then after it), or null.
function cueDistance(span: TaggedSpan, words: readonly Word[], cue: Cue): number | null {
  const first = words.findIndex((word) => word.end > span.start);
  const last = words.findLastIndex((word) => word.start < span.end);
  for (let distance = 1; distance <= Math.max(cue.before, cue.after); distance++) {
    if (distance <= cue.before && first - distance >= 0 && cuesAt(words, first - distance, cue)) return distance;
    if (distance <= cue.after && cuesAt(words, last + distance, cue)) return distance + 0.5;
  }
  return null;
}

function isList(bundle: RoleBundle, type: ParamType): boolean {
  return Object.hasOwn(bundle.listTypes, type);
}

// The params of an intent that take each span kind (order lines and enums aside).
function takers(bundle: RoleBundle, types: Readonly<Record<string, ParamType>>): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [name, type] of Object.entries(types)) {
    if (type === ORDER_LINES || bundle.enumTypes.has(type) || Object.hasOwn(bundle.listEnums, type)) continue;
    for (const kind of spanKindsOf(bundle, type)) found.set(kind, [...(found.get(kind) ?? []), name]);
  }
  return found;
}

interface Placed {
  readonly span: TaggedSpan;
  readonly distance: number;
}

// The params of an asked group (`ASKED_ROLES`) the intent has, when it has two of them or more.
function askedGroup(names: readonly string[]): readonly string[] | null {
  for (const group of ASKED_ROLES) {
    const present = group.filter((name) => names.includes(name));
    if (present.length > 1) return present;
  }
  return null;
}

function paramRoles(bundle: RoleBundle, types: Readonly<Record<string, ParamType>>, words: readonly Word[], spans: readonly TaggedSpan[], asks: RoleAsk[]): Map<string, TaggedSpan[]> {
  const placed = new Map<string, Placed[]>();
  const askedOf = new Map<string, readonly string[]>();
  const put = (name: string, span: TaggedSpan, distance: number) => placed.set(name, [...(placed.get(name) ?? []), { span, distance }]);
  for (const [kind, names] of takers(bundle, types)) {
    const unions = names.filter((name) => Object.hasOwn(bundle.unions, types[name] ?? ""));
    if (names.length < 2 && !unions.length) continue;
    const ofKind = spans.filter((span) => span.kind === kind);
    const mixed = ofKind.length > 1 || words.some((word) => says(word, REST_STEMS));
    const left: TaggedSpan[] = [];
    for (const span of ofKind) {
      const cued = names
        .map((name) => [name, PARAM_CUES[name]] as const)
        .flatMap(([name, cue]) => {
          if (cue === undefined || (cue.withOther === true && !mixed)) return [];
          const distance = cueDistance(span, words, cue);
          return distance === null ? [] : [[name, distance] as const];
        })
        .toSorted((one, other) => one[1] - other[1])[0];
      if (cued !== undefined) put(cued[0], span, cued[1]);
      else left.push(span);
    }
    const singles = names.filter((name) => !isList(bundle, types[name] ?? ""));
    const lists = names.filter((name) => isList(bundle, types[name] ?? ""));
    const asked = askedGroup(names);
    if (asked !== null) for (const name of asked) askedOf.set(name, asked);
    for (const span of left) {
      if (asked !== null) {
        asks.push({ names: asked, span });
        continue;
      }
      // D70: a union param (`discount`) takes a span with no cue only when no other param of the intent takes the type: «чек на 900 … 400 …» is a
      // total and a part, not a discount.
      const union = (name: string) => Object.hasOwn(bundle.unions, types[name] ?? "");
      const free = singles.find((name) => !placed.has(name) && !(union(name) && names.some((other) => !union(other)))) ?? lists[0];
      if (free !== undefined) put(free, span, Number.POSITIVE_INFINITY);
    }
  }
  // A single param keeps the span its cue is nearest to, then the first said; the others are asked about when the param is one the card asks (D70:
  // «оголошена вартість 2000, ще 1500» keeps 2000 as declared and asks about 1500), else they fill the first param of their type still empty that is
  // no union (D72: «чек на 1200 гривень знижкою 10%»: «10» is the discount, so «1200» is the amount, not a dropped second discount), else are dropped.
  const kinds = takers(bundle, types);
  const union = (name: string) => Object.hasOwn(bundle.unions, types[name] ?? "");
  const decided = new Map<string, TaggedSpan[]>();
  const losers: TaggedSpan[] = [];
  for (const [name, found] of placed) {
    const ordered = found.toSorted((one, other) => one.span.start - other.span.start);
    if (isList(bundle, types[name] ?? "")) {
      decided.set(name, ordered.map((item) => item.span));
      continue;
    }
    const nearest = ordered.reduce((kept, item) => (item.distance < kept.distance ? item : kept));
    const group = askedOf.get(name);
    for (const item of ordered) {
      if (item === nearest) continue;
      if (group !== undefined) asks.push({ names: group, span: item.span });
      else losers.push(item.span);
    }
    decided.set(name, [nearest.span]);
  }
  for (const span of losers.toSorted((one, other) => one.start - other.start)) {
    const free = (kinds.get(span.kind) ?? []).find((name) => !decided.has(name) && !union(name) && !isList(bundle, types[name] ?? "") && !askedOf.has(name));
    if (free !== undefined) decided.set(free, [span]);
  }
  return decided;
}

// The role of every line span: the nearest line cue before it, else the first one after it, else added.
function roleOf(span: TaggedSpan, cues: readonly (readonly [Word, LineRole])[]): readonly [LineRole, number] {
  const before = cues.filter(([word]) => word.end <= span.start).at(-1);
  const after = cues.find(([word]) => word.start >= span.end);
  const cue = before ?? after;
  return cue === undefined ? ["add", -1] : [cue[1], cue[0].start];
}

function lineOf(product: string | undefined, attrs: readonly TaggedSpan[], quantity: TaggedSpan | undefined): OrderLine | null {
  if (product === undefined) return null;
  const said = quantity === undefined ? [] : [quantity.text];
  return { product, attrs: attrs.map((span) => span.text), ...(quantity === undefined ? {} : { quantity: quantity.text }), said };
}

interface Change {
  readonly set: readonly OrderLine[];
  readonly remove: readonly OrderLine[];
  readonly add: readonly OrderLine[];
}

interface Parts {
  readonly old: readonly TaggedSpan[];
  readonly fresh: readonly TaggedSpan[];
}

function untagged(words: readonly Word[], from: number, to: number): Word[] {
  return words.filter((word) => !word.tagged && word.start >= from && word.end <= to);
}

// A change said with «не»: «не білі а рожеві», «на чотири а не на два», «ем а не ес» (the words after «не» are the old ones, up to «а»).
function negated(group: readonly TaggedSpan[], words: readonly Word[]): Parts | null {
  const first = group[0];
  const last = group.at(-1);
  if (first === undefined || last === undefined) return null;
  const inside = untagged(words, first.start, last.end);
  const not = inside.find((word) => NOT_WORDS.has(word.text));
  if (not === undefined) return null;
  const but = inside.find((word) => word.start > not.end && BUT_WORDS.has(word.text));
  const old = group.filter((span) => span.start > not.end && (but === undefined || span.end <= but.start));
  return old.length && old.length < group.length ? { old, fresh: group.filter((span) => !old.includes(span)) } : null;
}

// The old and the new part of a change: «не X а Y», then the last «на» between two spans («ноутбук асус на 8 гигов на 16»: the 8 GB one is the old
// line), then «замість X» up to the next change verb; else all of it is new.
function partsOf(group: readonly TaggedSpan[], words: readonly Word[]): Parts {
  const negation = negated(group, words);
  if (negation !== null) return negation;
  const cut = group.findLastIndex((span, index) => index > 0 && untagged(words, group[index - 1]?.end ?? 0, span.start).some((word) => NEW_AFTER.has(word.text)));
  if (cut > 0) return { old: group.slice(0, cut), fresh: group.slice(cut) };
  const instead = words.find((word) => !word.tagged && OLD_AFTER.has(word.text));
  if (instead === undefined) return { old: [], fresh: [...group] };
  const stop = words.find((word) => word.start > instead.end && !word.tagged && LINE_CUES.set.stems.some((stem) => word.text.startsWith(stem)) && !OLD_AFTER.has(word.text));
  const old = group.filter((span) => span.start > instead.end && (stop === undefined || span.end <= stop.start));
  return { old, fresh: group.filter((span) => !old.includes(span)) };
}

// D73: «айфон на версію» is «айфон»: «на» and a word that says another version of the product end its name.
function versionless(product: string | undefined): string | undefined {
  if (product === undefined) return undefined;
  const words = product.split(/\s+/).filter(Boolean);
  const at = words.findIndex((word, index) => VERSION_WORDS.has(word) || (NEW_AFTER.has(word) && VERSION_WORDS.has(words[index + 1] ?? "")));
  return at > 0 ? words.slice(0, at).join(" ") : product;
}

// One change. A new quantity alone, or new attrs for old ones said after «з» / «с» with the attribute named («колір … з сірого на чорний»), is a set
// line; new attrs or a new product for old ones is a swap: the old line removed, the new one added. `product` is the removed line's product when the
// change names none («прибери копію, постав оригінал»).
function changeOf(fields: RoleBundle["lineFields"], parts: Parts, words: readonly Word[], product: string | undefined): Change {
  const { old, fresh } = parts;
  const introduced = (span: TaggedSpan) => {
    const before = words.filter((word) => word.end <= span.start).at(-1);
    return before !== undefined && !before.tagged && OLD_BEFORE.has(before.text);
  };
  const of = (spans: readonly TaggedSpan[], kind: string) => spans.filter((span) => span.kind === kind);
  const attributeWord = (word: Word | undefined) => word !== undefined && !word.tagged && ATTRIBUTE_WORDS.some((stem) => word.text.startsWith(stem));
  const named = words.some(attributeWord);
  // D73: «заміни розмір сукні на 46»: with no product span, the old attr said right after the attribute's name is the line's product.
  const productless = product === undefined && !of(fresh, fields.product).length && !of(old, fields.product).length;
  const owner = productless ? of(old, fields.variant).find((span) => attributeWord(words.filter((word) => word.end <= span.start).at(-1))) : undefined;
  const said = versionless(of(fresh, fields.product)[0]?.text ?? of(old, fields.product)[0]?.text ?? owner?.text ?? product);
  const oldAttrs = of(old, fields.variant).filter((span) => span !== owner && !(named && introduced(span)));
  const newAttrs = of(fresh, fields.variant);
  const newQuantity = of(fresh, fields.quantity)[0];
  const newProduct = of(fresh, fields.product).length > 0;
  // The attribute named with the product it is of («размер кроссовок 42 на 43») changes that line's attr, as «з 42 на 43» does. D82: so does an old attr
  // and a new one with the attribute named and no «з» («зміни колір худі сірого на чорний»), when no new product is said.
  const saidOver = named && !newProduct && of(old, fields.variant).length > 0 && of(fresh, fields.variant).length > 0;
  const changedFrom = (named && of(old, fields.variant).some(introduced)) || owner !== undefined || saidOver;
  const swap = !changedFrom && (newAttrs.length > 0 || newProduct) && (oldAttrs.length > 0 || (of(old, fields.product).length > 0 && newProduct));
  if (swap) {
    const removed = lineOf(of(old, fields.product)[0]?.text ?? said, oldAttrs, of(old, fields.quantity)[0]);
    const added = lineOf(said, newAttrs, newQuantity);
    return { set: [], remove: removed === null ? [] : [removed], add: added === null ? [] : [added] };
  }
  const line = lineOf(said, newAttrs.length || changedFrom ? newAttrs : oldAttrs, newQuantity ?? of(old, fields.quantity)[0]);
  return { set: line === null ? [] : [line], remove: [], add: [] };
}

// `orders.update`: the lines of each order-line param (intents v3 §6b). A group of line spans with one role is read as a list (`pairLines`) when it is
// added or removed, and as a change when a change verb or «не … а» says so; a change with no old part right after a removal replaces what was
// removed («прибери сет філадельфія, заміни на сет запечений»: the new one is added).
function lineRoles(bundle: RoleBundle, names: readonly string[], utterance: string, words: readonly Word[], spans: readonly TaggedSpan[]): Map<string, OrderLine[]> {
  const fields = bundle.lineFields;
  const kinds = new Set([fields.product, fields.variant, fields.quantity]);
  const items = spans.filter((span) => kinds.has(span.kind));
  const roles = Object.entries(LINE_CUES) as [LineRole, (typeof LINE_CUES)[LineRole]][];
  const cues = words.flatMap((word) => roles.filter(([, cue]) => says(word, cue.stems, cue.words)).slice(0, 1).map(([role]) => [word, role] as const));
  const groups: { role: LineRole; spans: TaggedSpan[] }[] = [];
  for (const span of items) {
    const [role] = roleOf(span, cues);
    const last = groups.at(-1);
    if (last !== undefined && last.role === role) last.spans.push(span);
    else groups.push({ role, spans: [span] });
  }
  const pick = (name: string) => (names.includes(name) ? name : (names[0] ?? name));
  const [addName, removeName, setName] = [pick("items"), pick("remove_items"), pick("set_items")];
  const found = new Map<string, OrderLine[]>();
  const push = (name: string, lines: readonly OrderLine[]) => {
    if (lines.length) found.set(name, [...(found.get(name) ?? []), ...lines]);
  };
  let removed: readonly OrderLine[] = [];
  for (const group of groups) {
    if (group.role !== "set" && negated(group.spans, words) === null) {
      const lines = pairLines(bundle, group.spans, utterance);
      push(group.role === "remove" ? removeName : addName, lines);
      removed = group.role === "remove" ? lines : [];
      continue;
    }
    const parts = partsOf(group.spans, words);
    const read = changeOf(fields, parts, words, removed.at(-1)?.product);
    push(removed.length > 0 && !parts.old.length ? addName : setName, read.set);
    push(removeName, read.remove);
    push(addName, read.add);
    removed = [];
  }
  return found;
}

// The roles of an intent's params, or null when no two of them share a type, none is a union and it has at most one order-line param: then every param
// reads as a v2 param does (`params.ts` `paramValue`).
export function assignRoles(bundle: RoleBundle, types: Readonly<Record<string, ParamType>>, utterance: string, spans: readonly TaggedSpan[]): Roles | null {
  const lineParams = Object.entries(types).filter(([, type]) => type === ORDER_LINES).map(([name]) => name);
  const shared = [...takers(bundle, types).values()].some((names) => names.length > 1 || names.some((name) => Object.hasOwn(bundle.unions, types[name] ?? "")));
  if (!shared && lineParams.length < 2) return null;
  const words = wordsOf(utterance, spans);
  const sharing = [...takers(bundle, types).values()].filter((names) => names.length > 1 || names.some((name) => Object.hasOwn(bundle.unions, types[name] ?? "")));
  const asks: RoleAsk[] = [];
  return {
    spans: shared ? paramRoles(bundle, types, words, spans, asks) : new Map(),
    lines: lineParams.length > 1 ? lineRoles(bundle, lineParams, utterance, words, spans) : new Map(),
    covered: new Set([...sharing.flat(), ...(lineParams.length > 1 ? lineParams : [])]),
    asks: asks.toSorted((one, other) => one.span.start - other.span.start),
  };
}
