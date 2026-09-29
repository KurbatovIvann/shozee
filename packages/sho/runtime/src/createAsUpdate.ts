import { intentOfAction, type Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { Decision } from "./command.ts";
import { DATIVE_ADD_VERBS, DATIVE_CUSTOMER_LEADS, DATIVE_NAME_ENDINGS, DATIVE_SHORT_ENDINGS, NEW_WORDS, RENAME_VERBS } from "./lexicon/customers.ts";
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
