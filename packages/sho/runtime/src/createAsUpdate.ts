import { intentOfAction, isV3, type Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { Decision } from "./command.ts";
import type { Need } from "./result.ts";
import { DATIVE_ADD_VERBS, DATIVE_CUSTOMER_LEADS, DATIVE_NAME_ENDINGS, DATIVE_SHORT_ENDINGS, NEW_WORDS, RENAME_VERBS } from "./lexicon/customers.ts";
import { CONTINUATION_MORE, ORDER_EDIT_STEMS, ORDER_NOUN_BARE, ORDER_NOUN_LEADS, ORDER_NOUN_STEMS } from "./lexicon/references.ts";
import { nameMatch, nameWords } from "./nameList.ts";

// D84 (E10 of the v3.3 served report): the first rule where the runtime serves another action than the model's (D85 below is the second). «додай клієнту Євген Панасюк коментар бере
// лише техніку Apple» is read by the model as `customers.createCustomer {new_name, comment}`; when the customer list knows that name whole, and the name is
// addressed in the dative, it is that customer's `customers.updateCustomer {customer, comment}`, with a non-blocking need
// `{path: "action", reason: "read_as_update", span: {text: <the name as said>}}` so the card says the create was read as an update. All of these must hold:
//   1. the model's action is `customers.createCustomer` and the bundle has `customers.updateCustomer`;
//   2. its `new_name` span names exactly one customer of the context whole: as many words as the known name, each a form of the known word
//      (`nameMatch`, with D82's short-name and case-form rules); a first name alone for «Олег Тищенко», another surname or two customers is no match;
//   3. the name is addressed in the dative: right after «клієнту / клієнтові / клієнтці / клиенту / клиентке» (`DATIVE_CUSTOMER_LEADS`), or right after
//      the command's first word «додай / добав / …» (`DATIVE_ADD_VERBS`) with its first word in a masculine dative form of the known one («шерлоку»,
//      «олегові», `DATIVE_NAME_ENDINGS`, `DATIVE_SHORT_ENDINGS`);
//   4. no word before the name says the customer is new («нового», «новому клієнту», `NEW_WORDS`; «… новий коментар» after it is the comment's);
//   5. the create carries something the update takes: `phone`, `email`, `comment`, `group` or `price_list`.
// Anything else keeps the model's create: «додай клієнта Олег, телефон …» with an Олег in the list stays a create (a new person may share a name).
//
// D85 (F1 of the dictation v5 report): the second such rule, `groupAsUpdate` below. «Групу Петя Жолоб, зміни на роздріб» is read by the model as
// `customers.updateGroup {group: петя жолоб, rename_to: роздріб}`: a customer's group changed, said as «the group of Петя Жолоб». When the group span
// names a customer of the context whole and no group, it is that customer's `customers.updateCustomer {customer, group}`, with a non-blocking need
// `{path: "action", reason: "read_as_customer_update", span: {text: <the name as said>}}`. All of these must hold:
//   1. the model's action is `customers.updateGroup` and the bundle has `customers.updateCustomer`;
//   2. its `group` span names exactly one customer of the context whole (`knownWhole`, as D84's `new_name`);
//   3. the span names no group of the context's group list (any hit, whole, in part or by a word, keeps the group edit);
//   4. no rename verb is said («перейменуй», «переименуй», «переназви», `RENAME_VERBS`): renaming is the group's;
//   5. the edit carries a new group (`rename_to`, served as the customer's `group`) or a `price_list`, and nothing else (a `description` is the group's).

const CREATE = "customers.createCustomer";
const UPDATE = "customers.updateCustomer";
const NEW_NAME = "new_name";
const CUSTOMER = "customer";
const UPDATED: readonly string[] = ["phone", "email", "comment", "group", "price_list"];
const SHORT_BEFORE = /[бвгґджзклмнпрстфхцчшщйьо]$/u;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// The one customer the words name whole, or null.
function knownWhole(words: readonly string[], context: CompiledContext): string | null {
  const list = context.records.lists.customers;
  if (list === null || !words.length) return null;
  const names = context.customers.startingWith(words[0] ?? "").filter(([, known]) => known.length === words.length && known.every((word, index) => nameMatch(words[index] ?? "", word)));
  const owners = new Set(names.flatMap(([name]) => list.named(name)));
  const [only] = names;
  return owners.size === 1 && only !== undefined ? only[0] : null;
}

// «шерлоку» of «Шерлок», «олегові» of «Олег», «андрію» of «Андрій», «петру» of «Петро»: a masculine dative, never a feminine accusative («марію»).
function dativeOf(said: string, known: string): boolean {
  const stem = /[йьо]$/u.test(known) ? known.slice(0, -1) : known;
  if (DATIVE_NAME_ENDINGS.some((ending) => said === `${stem}${ending}` || said === `${known}${ending}`)) return true;
  return SHORT_BEFORE.test(known) && DATIVE_SHORT_ENDINGS.some((ending) => said === `${stem}${ending}`);
}

const GROUP_EDIT = "customers.updateGroup";
const GROUP = "group";
// D85: what a group edit may carry for the rule, and the customer update's param each becomes.
const GROUP_EDIT_TO_CUSTOMER: Readonly<Record<string, string>> = { rename_to: GROUP, price_list: "price_list" };

export interface AsUpdate {
  readonly decision: Decision;
  // The name as said, for the `read_as_update` need (D85: `read_as_customer_update`); null when the model's action stands.
  readonly said: string | null;
}

export function createAsUpdate(bundle: Bundle, decision: Decision, context: CompiledContext | null): AsUpdate {
  const kept = { decision, said: null };
  const span = decision.params[NEW_NAME];
  if (decision.action !== CREATE || context === null || typeof span !== "string" || !Object.hasOwn(bundle.intents, UPDATE)) return kept;
  const takes = intentOfAction(bundle, UPDATE).intent.params;
  if (!Object.hasOwn(takes, CUSTOMER) || !UPDATED.some((name) => Object.hasOwn(takes, name) && decision.params[name] !== undefined)) return kept;
  const text = wordsOf(decision.text);
  let said = wordsOf(span);
  if (DATIVE_CUSTOMER_LEADS.has(said[0] ?? "")) said = said.slice(1);
  const at = text.findIndex((_, start) => said.length > 0 && said.every((word, offset) => text[start + offset] === word));
  if (at < 0 || text.slice(0, at).some((word) => NEW_WORDS.has(word))) return kept;
  const name = knownWhole(said, context);
  if (name === null) return kept;
  const lead = text[at - 1] ?? "";
  const known = nameWords(name);
  const dative = DATIVE_CUSTOMER_LEADS.has(lead) || (at === 1 && DATIVE_ADD_VERBS.has(lead) && dativeOf(said[0] ?? "", known[0] ?? ""));
  if (!dative) return kept;
  const { [NEW_NAME]: _name, ...rest } = decision.params;
  const words = said.join(" ");
  return {
    decision: { ...decision, action: intentOfAction(bundle, UPDATE).action, params: { [CUSTOMER]: words, ...rest }, resolved: { ...decision.resolved, [CUSTOMER]: name } },
    said: words,
  };
}

// D85 (F1): a group edit whose group is a customer the list knows whole, and no group, is that customer's update (the conditions above).
export function groupAsUpdate(bundle: Bundle, decision: Decision, context: CompiledContext | null): AsUpdate {
  const kept = { decision, said: null };
  const span = decision.params[GROUP];
  if (decision.action !== GROUP_EDIT || context === null || typeof span !== "string" || !Object.hasOwn(bundle.intents, UPDATE)) return kept;
  const takes = intentOfAction(bundle, UPDATE).intent.params;
  const rest = Object.entries(decision.params).filter(([name]) => name !== GROUP);
  const moved = rest.flatMap(([name, value]) => {
    const target = GROUP_EDIT_TO_CUSTOMER[name];
    return target !== undefined && Object.hasOwn(takes, target) ? [[target, value] as const] : [];
  });
  if (!Object.hasOwn(takes, CUSTOMER) || !moved.length || moved.length !== rest.length) return kept;
  if (wordsOf(decision.text).some((word) => RENAME_VERBS.has(word))) return kept;
  const said = wordsOf(span);
  const name = knownWhole(said, context);
  if (name === null) return kept;
  const groups = context.records.lists.groups;
  const hits = groups === null ? null : groups.hits(span);
  if (hits !== null && (hits.whole.length > 0 || hits.part.length > 0 || hits.named.length > 0)) return kept;
  const words = said.join(" ");
  return {
    decision: { ...decision, action: intentOfAction(bundle, UPDATE).action, params: { [CUSTOMER]: words, ...Object.fromEntries(moved) }, resolved: { ...decision.resolved, [CUSTOMER]: name } },
    said: words,
  };
}

// D92 (P1 of the v3.4 served report, owner-approved 2026-09-30): the third rule that changes the model's action. v3.4 reads «замовлення Петі Жолоба
// сандалі 39 2 пари» (probe_ood po-sh-10) and «и сразу заказ ему на пять пирожков» (a customer just created, focus fc12) as `orders.update {customer,
// items}`: `orders.update` needs no order number, so the card was ready to update some order of that customer's the words never named. When nothing
// says an order exists, it is that customer's new order: `orders.create` with the same params and a non-blocking need `{path: "action", reason:
// "read_as_create", span: {text: <the customer as said>}}`. All of these must hold:
//   1. a v3 bundle; the served action is `orders.update` and the bundle has `orders.create`;
//   2. no order: no `order_number` said, from an earlier command of the utterance (`refPrevious`), from the previous command or bound from the focus
//      (`fromPrevious`: D88/D90's continuation «і ще …» binds its order there and stays as it is);
//   3. items and a customer: said, from an earlier command, or bound by a reference word («ему»);
//   4. no word says the order exists: no «ще / еще / ещё», no order noun but the bare «замовлення / заказ» and none after a preposition («в замовлення»,
//      «у заказі», «до замовлення»), no verb that adds to, changes or takes from an order («додай», «допиши», «поміняй», «убери», «перенеси»,
//      `ORDER_EDIT_STEMS`).
// When the update also carries what a create does not take (`remove_items`, `set_items`), there is no clean create: the update stays with a blocking
// need `{path: "order_number", reason: "missing"}`, so the card never updates an order it did not name.
const ORDER_UPDATE = "orders.update";
const ORDER_CREATE = "orders.create";
const ORDER_NUMBER = "order_number";
const ITEMS = "items";

export interface AsCreate {
  readonly decision: Decision;
  // The need the rule adds: `read_as_create` when the update was served as the new order, `order_number/missing` when it stays an update; else null.
  readonly need: Need | null;
}

function orderSaid(words: readonly string[]): boolean {
  return words.some((word, at) => {
    if (CONTINUATION_MORE.has(word) || ORDER_EDIT_STEMS.some((stem) => word.startsWith(stem))) return true;
    if (!ORDER_NOUN_STEMS.some((stem) => word.startsWith(stem))) return false;
    return !ORDER_NOUN_BARE.has(word) || ORDER_NOUN_LEADS.has(words[at - 1] ?? "");
  });
}

function customerSaid(decision: Decision): string | null {
  const span = decision.params[CUSTOMER];
  if (typeof span === "string") return span;
  const ref = decision.fromPrevious?.[CUSTOMER];
  const text = typeof ref === "object" && ref !== null && !Array.isArray(ref) && "text" in ref ? ref.text : undefined;
  return typeof text === "string" ? text : null;
}

export function updateAsCreate(bundle: Bundle, decision: Decision): AsCreate {
  const kept = { decision, need: null };
  if (!isV3(bundle) || !Object.hasOwn(bundle.intents, ORDER_UPDATE) || !Object.hasOwn(bundle.intents, ORDER_CREATE)) return kept;
  const update = intentOfAction(bundle, ORDER_UPDATE);
  if (decision.action !== update.action) return kept;
  const bound = decision.fromPrevious ?? {};
  const has = (name: string) => decision.params[name] !== undefined || Object.hasOwn(decision.refPrevious, name) || Object.hasOwn(bound, name);
  if (has(ORDER_NUMBER) || !has(ITEMS) || !has(CUSTOMER) || orderSaid(wordsOf(decision.text))) return kept;
  const create = intentOfAction(bundle, ORDER_CREATE);
  const clean = [...Object.keys(decision.params), ...Object.keys(decision.refPrevious), ...Object.keys(bound)].every((name) => Object.hasOwn(create.intent.params, name));
  if (!clean) return { decision, need: { path: ORDER_NUMBER, reason: "missing", blocking: true } };
  const said = customerSaid(decision);
  return { decision: { ...decision, action: create.action }, need: { path: "action", reason: "read_as_create", blocking: false, ...(said === null ? {} : { span: { text: said } }) } };
}
