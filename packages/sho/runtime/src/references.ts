import { intentOfAction, isV3, type ActionName, type Bundle, type ParamType } from "./bundle.ts";
import { CUSTOMER_PARAM, ITEMS_PARAM } from "./catalogue.ts";
import type { Resolved, ResolvedName } from "./customers.ts";
import { ORDER_FOLLOW_UPS, ORDER_REFS, PRICE_LIST_REFS, PRONOUNS, RECORD_REFS, REF_PHRASES } from "./lexicon/references.ts";
import type { OrderLine } from "./lines.ts";
import { isLines, isNames, paramValues, type ParamValue, type Params, type Values } from "./params.ts";
import { summed } from "./repair.ts";

export type { Resolved };
export type References = Readonly<Record<string, number>>;

export interface Segment {
  readonly text: string;
  readonly action: ActionName;
  readonly params: Params;
  readonly resolved: Resolved;
}

export interface Referencing {
  readonly action: ActionName;
  readonly params: Params;
  readonly resolved: Resolved;
  readonly refPrevious: References;
  readonly values: Values;
}

export type Referenced<T extends Segment> = T & Referencing;

export interface Filling {
  readonly text: string;
  action: ActionName;
  params: Record<string, ParamValue>;
  refPrevious: Record<string, number>;
  resolved: Record<string, ResolvedName>;
}

export type CustomerSource = readonly [param: string, value: string];
export type NameOf = (span: string) => string | null;

export const ELLIPSIS_TYPES: ReadonlySet<ParamType> = new Set(["customer", "pick_text", "search_text"]);
export const FRAGMENT_ACTIONS: ReadonlySet<string> = new Set(["ui.confirm", "ui.reject", "ui.pick", "none"]);
export const NEW_CUSTOMER = "customers.createCustomer";
export const ORDER_CREATE = "orders.create";
export const NO_COMMAND = "none";
export const GROUP_MOVE = "customers.setGroup";
export const CUSTOMER_UPDATE = "customers.updateCustomer";

const CUSTOMER_TYPE: ParamType = "customer";
const CUSTOMERS_PARAM = "customers";
const GROUP_PARAM = "group";
const MOVE_PARAMS: ReadonlySet<string> = new Set([CUSTOMER_PARAM, CUSTOMERS_PARAM, GROUP_PARAM]);
const NEW_NAME_PARAM = "new_name";
const ORDER_NUMBER_PARAM = "order_number";
const PRICE_LIST_PARAM = "price_list";
const UNKNOWN_NAME: NameOf = () => null;

type IntentBundle = Pick<Bundle, "intents">;
// A bundle that may name its label set: the v3 rules (D70) run only for `catalogue: "v3"`.
type ReferenceBundle = IntentBundle & Partial<Pick<Bundle, "catalogue">>;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function typesOf(bundle: IntentBundle, action: string): Readonly<Record<string, ParamType>> {
  return intentOfAction(bundle, action).intent.params;
}

function typeOf(types: Readonly<Record<string, ParamType>>, name: string): ParamType | undefined {
  return Object.hasOwn(types, name) ? types[name] : undefined;
}

function orderLines(value: ParamValue | undefined): readonly OrderLine[] | null {
  return isLines(value) ? value : null;
}

function hasPhrase(words: readonly string[], phrase: string): boolean {
  const wanted = phrase.split(" ");
  for (let index = 0; index + wanted.length <= words.length; index++) {
    if (wanted.every((word, offset) => words[index + offset] === word)) return true;
  }
  return false;
}

export function refPhrase(text: string): string | null {
  const words = wordsOf(text);
  return REF_PHRASES.find((phrase) => hasPhrase(words, phrase)) ?? null;
}

export function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const words = wordsOf(text);
  return phrases.some((phrase) => hasPhrase(words, phrase));
}

export function isPronoun(value: ParamValue | undefined): boolean {
  return typeof value === "string" && (REF_PHRASES.includes(value) || wordsOf(value).every((word) => PRONOUNS.has(word)));
}

export function customerSource(command: Pick<Segment, "action" | "params">): CustomerSource | null {
  const customer = command.params[CUSTOMER_PARAM];
  if (typeof customer === "string" && !isPronoun(customer)) return [CUSTOMER_PARAM, customer];
  const name = command.params[NEW_NAME_PARAM];
  if (command.action === NEW_CUSTOMER && typeof name === "string") return [NEW_NAME_PARAM, name];
  return null;
}

export function customerParam(bundle: IntentBundle, action: string): string | null {
  const found = Object.entries(typesOf(bundle, action)).find(([, type]) => type === CUSTOMER_TYPE);
  return found ? found[0] : null;
}

function claimable(params: Readonly<Record<string, ParamValue>>, name: string): boolean {
  return !Object.hasOwn(params, name) || isPronoun(params[name]);
}

export function fillFrom(bundle: IntentBundle, command: Filling, previous: Referencing, sourceIndex: number, phrase: string): void {
  const params = command.params;
  const types = typesOf(bundle, command.action);
  const order = previous.params[ORDER_NUMBER_PARAM];
  if (ORDER_REFS.has(phrase) && Object.hasOwn(types, ORDER_NUMBER_PARAM) && !params[ORDER_NUMBER_PARAM] && typeof order === "string") {
    params[ORDER_NUMBER_PARAM] = order;
    command.refPrevious[ORDER_NUMBER_PARAM] = sourceIndex;
    return;
  }
  const source = customerSource(previous);
  if (source === null && previous.action === NEW_CUSTOMER) {
    for (const [name, type] of Object.entries(types)) {
      if (type !== CUSTOMER_TYPE || !claimable(params, name)) continue;
      delete params[name];
      command.refPrevious[name] = sourceIndex;
      delete command.resolved[name];
    }
    return;
  }
  if (source === null) return;
  const [sourceName, value] = source;
  for (const [name, type] of Object.entries(types)) {
    if (type !== CUSTOMER_TYPE || !claimable(params, name)) continue;
    params[name] = value;
    command.refPrevious[name] = sourceIndex;
    delete command.resolved[name];
    const inherited = Object.hasOwn(previous.resolved, sourceName) ? previous.resolved[sourceName] : undefined;
    if (inherited !== undefined) command.resolved[name] = inherited;
  }
}

export function recordReference(bundle: IntentBundle, command: Filling, previous: Pick<Segment, "action">, sourceIndex: number): boolean {
  const target = RECORD_REFS.get(previous.action);
  if (target === undefined) return false;
  const [name, phrases] = target;
  if (!Object.hasOwn(typesOf(bundle, command.action), name) || command.params[name] || !containsPhrase(command.text, phrases)) return false;
  command.refPrevious[name] = sourceIndex;
  return true;
}

// D82 (E9): «постав круасан 40 гривень у прайсі гуртовий, прибери з нього круасан»: a command that takes a price list and names none, said right after
// one that names a price list, with words that point back at it (`PRICE_LIST_REFS`), takes that price list (`refPrevious.price_list`), as `fillFrom`
// takes an order.
export function priceListReference(bundle: IntentBundle, command: Filling, previous: Pick<Segment, "params">, sourceIndex: number): boolean {
  const said = previous.params[PRICE_LIST_PARAM];
  if (typeof said !== "string" || !Object.hasOwn(typesOf(bundle, command.action), PRICE_LIST_PARAM) || command.params[PRICE_LIST_PARAM]) return false;
  if (!containsPhrase(command.text, PRICE_LIST_REFS)) return false;
  command.params[PRICE_LIST_PARAM] = said;
  command.refPrevious[PRICE_LIST_PARAM] = sourceIndex;
  return true;
}

// D70 (intents v3 §4.2): an order and what follows it in one breath («замовлення для Олени …, і відправ новою поштою в Рівне»): a shipment, a receipt, a
// payment link, a document or a payment mark that names no order takes the new one (`refPrevious.order_number`, D27), also over other follow-ups
// («… пробий чек і відправ новою поштою»). v3 bundles only: a v2 bundle keeps D27's phrase rule.
export function orderFollowUp(bundle: IntentBundle, command: Filling, earlier: readonly Pick<Segment, "action">[]): boolean {
  if (!ORDER_FOLLOW_UPS.has(command.action) || !Object.hasOwn(typesOf(bundle, command.action), ORDER_NUMBER_PARAM)) return false;
  if (command.params[ORDER_NUMBER_PARAM] || Object.hasOwn(command.refPrevious, ORDER_NUMBER_PARAM)) return false;
  const order = earlier.findLastIndex((found) => found.action === ORDER_CREATE);
  if (order < 0 || earlier.slice(order + 1).some((found) => !ORDER_FOLLOW_UPS.has(found.action))) return false;
  command.refPrevious[ORDER_NUMBER_PARAM] = order;
  return true;
}

function ellipsisSpan(bundle: IntentBundle, command: Pick<Segment, "text" | "action" | "params">): readonly [name: string, value: string] | null {
  const entries = Object.entries(command.params);
  const only = entries[0];
  if (entries.length !== 1 || only === undefined) return null;
  const [name, value] = only;
  const type = typeOf(typesOf(bundle, command.action), name);
  return value === command.text && type !== undefined && ELLIPSIS_TYPES.has(type) ? [name, value] : null;
}

function isEllipsis(bundle: IntentBundle, command: Pick<Segment, "text" | "action" | "params">, previous: Pick<Segment, "action">): boolean {
  return customerParam(bundle, previous.action) !== null && ellipsisSpan(bundle, command) !== null;
}

export function ellipsis(bundle: IntentBundle, command: Filling, previous: Referencing, sourceIndex: number, nameOf: NameOf = UNKNOWN_NAME): boolean {
  const target = customerParam(bundle, previous.action);
  const span = ellipsisSpan(bundle, command);
  if (target === null || span === null) return false;
  const [name, value] = span;
  command.action = previous.action;
  command.params = { ...Object.fromEntries(Object.entries(previous.params).filter(([key]) => key !== target)), [target]: value };
  const inherited = Object.fromEntries(Object.keys(previous.params).filter((key) => key !== target && !Object.hasOwn(previous.refPrevious, key)).map((key) => [key, sourceIndex]));
  command.refPrevious = { ...Object.fromEntries(Object.entries(previous.refPrevious).filter(([key]) => key !== target)), ...inherited };
  const resolved = Object.hasOwn(command.resolved, name) ? command.resolved[name] : (nameOf(value) ?? undefined);
  command.resolved = resolved === undefined ? {} : { [target]: resolved };
  return true;
}

export function withoutFragments<T extends Pick<Segment, "text" | "action">>(commands: readonly T[], continues: (command: T, previous: T) => boolean = () => false): T[] {
  const kept: T[] = [];
  for (const command of commands) {
    const previous = kept.at(-1);
    if (previous === undefined || wordsOf(command.text).length > 1 || !FRAGMENT_ACTIONS.has(command.action) || continues(command, previous)) kept.push(command);
  }
  return kept;
}

export function mergedOrders<T extends Pick<Segment, "action" | "params">>(commands: readonly T[]): T[] {
  const merged: T[] = [];
  for (const command of commands) {
    const previous = merged.at(-1);
    const items = orderLines(command.params[ITEMS_PARAM]);
    const previousItems = previous === undefined ? null : orderLines(previous.params[ITEMS_PARAM]);
    const opened = previous !== undefined && (previousItems !== null || typeof previous.params[CUSTOMER_PARAM] === "string");
    if (previous !== undefined && opened && previous.action === ORDER_CREATE && command.action === ORDER_CREATE && items !== null && !command.params[CUSTOMER_PARAM]) {
      const lines = summed([...(previousItems ?? []), ...items].map((line) => ({ line, stray: false, cued: false })));
      merged[merged.length - 1] = { ...previous, params: { ...previous.params, [ITEMS_PARAM]: lines } };
      continue;
    }
    merged.push(command);
  }
  return merged;
}

export function lostCommand(parts: readonly Pick<Segment, "action">[], kept: readonly Pick<Segment, "action">[], whole: Pick<Segment, "action">): boolean {
  return kept.length < parts.length && kept.every((command) => command.action === NO_COMMAND) && !FRAGMENT_ACTIONS.has(whole.action);
}

type MoveGroup = readonly [kind: "said", text: string] | readonly [kind: "record", index: number];

interface Move {
  readonly customers: readonly string[];
  readonly resolved: readonly (string | null)[];
  readonly group: MoveGroup | null;
}

function moveOf(command: Referencing): Move | null {
  if (command.action !== CUSTOMER_UPDATE && command.action !== GROUP_MOVE) return null;
  if (!Object.keys(command.params).every((name) => MOVE_PARAMS.has(name)) || !Object.keys(command.refPrevious).every((name) => name === GROUP_PARAM)) return null;
  const one = command.params[CUSTOMER_PARAM];
  const many = command.params[CUSTOMERS_PARAM];
  const customers = typeof one === "string" && !isPronoun(one) ? [one] : isNames(many) ? many : [];
  if (!customers.length) return null;
  const known = command.resolved[typeof one === "string" ? CUSTOMER_PARAM : CUSTOMERS_PARAM];
  const resolved = customers.map((_, index) => (typeof known === "string" ? known : (known?.[index] ?? null)));
  const said = command.params[GROUP_PARAM];
  const record = command.refPrevious[GROUP_PARAM];
  const group: MoveGroup | null = typeof said === "string" ? ["said", said] : record !== undefined ? ["record", record] : null;
  return { customers, resolved, group };
}

function sameGroup(left: MoveGroup, right: MoveGroup): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

// The chain a group move starts at `start`: the moves right after it that name the same group, take it by reference from a move in the chain (an ellipsis,
// «… в групу оптові і Надю»), or name none (the group said after the names: «додай Альбіну | і Надю в групу оптові»).
function moveChain(commands: readonly Referencing[], start: number): readonly [end: number, group: MoveGroup | null] {
  let group: MoveGroup | null = null;
  let end = start;
  for (; end < commands.length; end++) {
    const command = commands[end];
    const move = command === undefined ? null : moveOf(command);
    if (move === null) break;
    const inChain = move.group !== null && move.group[0] === "record" && move.group[1] >= start;
    if (inChain) continue;
    if (move.group !== null && group !== null && !sameGroup(move.group, group)) break;
    group ??= move.group;
  }
  return [end, group];
}

function mergedMove<T extends Segment>(bundle: IntentBundle, chain: readonly Referenced<T>[], group: MoveGroup, renumber: (index: number) => number): Referenced<T> | null {
  const [first] = chain;
  const customers: string[] = [];
  const resolved: (string | null)[] = [];
  for (const move of chain.map(moveOf)) {
    for (const [index, customer] of (move?.customers ?? []).entries()) {
      if (customers.includes(customer)) continue;
      customers.push(customer);
      resolved.push(move?.resolved[index] ?? null);
    }
  }
  if (first === undefined || customers.length < 2) return null;
  const { action, intent } = intentOfAction(bundle, GROUP_MOVE);
  const params: Record<string, ParamValue> = group[0] === "said" ? { [CUSTOMERS_PARAM]: customers, [GROUP_PARAM]: group[1] } : { [CUSTOMERS_PARAM]: customers };
  const refPrevious: References = group[0] === "record" ? { [GROUP_PARAM]: renumber(group[1]) } : {};
  const known: Resolved = resolved.some((name) => name !== null) ? { [CUSTOMERS_PARAM]: resolved } : {};
  const text = chain.map((command) => command.text).join(" ");
  return { ...first, text, action, params, resolved: known, refPrevious, values: paramValues(intent.params, params) };
}

// D58 safety net, only for bundles that know customers.setGroup: a chain of one-customer group moves the segmenter cut apart is the one list move the
// person said. Bundles without setGroup (v2q and older) keep the per-name commands.
export function groupMoves<T extends Segment>(bundle: IntentBundle, commands: readonly Referenced<T>[]): Referenced<T>[] {
  if (!Object.hasOwn(bundle.intents, GROUP_MOVE)) return [...commands];
  const kept: Referenced<T>[] = [];
  const moved: number[] = [];
  const renumber = (index: number): number => moved[index] ?? index;
  let start = 0;
  while (start < commands.length) {
    const [end, group] = moveChain(commands, start);
    const merged = group !== null && end - start > 1 ? mergedMove(bundle, commands.slice(start, end), group, renumber) : null;
    const taken = merged === null ? 1 : end - start;
    for (let index = 0; index < taken; index++) moved.push(kept.length);
    const command = commands[start];
    if (merged !== null) kept.push(merged);
    else if (command !== undefined) kept.push({ ...command, refPrevious: Object.fromEntries(Object.entries(command.refPrevious).map(([name, index]) => [name, renumber(index)])) });
    start += taken;
  }
  return kept;
}

export function fillReferences<T extends Segment>(bundle: ReferenceBundle, all: readonly T[], nameOf: NameOf = UNKNOWN_NAME): Referenced<T>[] {
  const v3 = isV3({ catalogue: bundle.catalogue ?? null });
  const filled: Referenced<T>[] = [];
  for (const original of mergedOrders(withoutFragments(all, (command, previous) => isEllipsis(bundle, command, previous)))) {
    const command: Filling = { text: original.text, action: original.action, params: { ...original.params }, refPrevious: {}, resolved: { ...original.resolved } };
    const previous = filled.at(-1);
    const sourceIndex = filled.length - 1;
    let phrase = previous === undefined ? null : refPhrase(command.text);
    if (previous !== undefined && ellipsis(bundle, command, previous, sourceIndex, nameOf)) phrase = null;
    else if (previous !== undefined && recordReference(bundle, command, previous, sourceIndex)) phrase = null;
    else if (previous !== undefined && priceListReference(bundle, command, previous, sourceIndex)) phrase = null;
    if (previous !== undefined && phrase !== null) fillFrom(bundle, command, previous, sourceIndex, phrase);
    // D70: a pronoun in a follow-up two commands after the order («… пробий чек і відправ йому») takes the order's customer, as D27 takes it from the
    // command right before.
    const order = v3 && orderFollowUp(bundle, command, filled) ? filled[command.refPrevious[ORDER_NUMBER_PARAM] ?? -1] : undefined;
    if (order !== undefined && order !== previous && phrase !== null) fillFrom(bundle, command, order, command.refPrevious[ORDER_NUMBER_PARAM] ?? 0, phrase);
    const values = paramValues(typesOf(bundle, command.action), command.params);
    filled.push({ ...original, action: command.action, params: command.params, resolved: command.resolved, refPrevious: command.refPrevious, values });
  }
  return groupMoves(bundle, filled);
}
