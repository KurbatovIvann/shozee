import type { Params } from "./params.ts";
import type { Need } from "./result.ts";
import { LEGAL_FORMS } from "./lexicon/customers.ts";
import {
  CATEGORY_WORDS,
  CHAT_ADJECTIVES,
  CHAT_PLACE_LEADS,
  CHAT_WORDS,
  COMPANY_WORDS,
  COUNTERPARTY_STEMS,
  GOODS_ADJECTIVES,
  GOODS_GENITIVES,
  GROUP_WORDS,
  MESSENGER_STEMS,
  OBJECT_FILLERS,
  OBJECT_VERB_STEMS,
  OWN_POSSESSIVES,
  REQUISITES_WORDS,
  STAFF_GROUP_GENITIVES,
  STAFF_WORDS,
} from "./lexicon/objects.ts";

// D93 (family 4 of Shozee's SHO-740 routing check, owner-approved 2026-09-30): the served action acts on one type of record (a customer, a group of
// customers, a counterparty, a product), but the words name, as the object of the verb, a kind of thing ШО does not handle or that is not that
// type. The model knows only its own actions and maps such an object onto the nearest one with confidence («Створи групу товарів «Десерти»» was a
// ready `customers.createGroup` 0.999; «Додай нового працівника Кирила Бондаря …» a ready `customers.createCustomer`). The command keeps the model's
// action and params and gets the blocking need `{path: "action", reason: "unsupported", span: {text: <the object as said>}}` (D72's reason, a new
// path), so the card declines instead of writing. The objects:
//   - a product group: «група / групу товарів, продуктів, продукції, позицій, страв», «товарна група», «категорію товарів», ru «группу товаров»,
//     «товарную группу», «категорию товаров»: ШО has no product groups or categories. A bare category («категорію піцерії», «категорію клієнтів») is
//     a group of customers, as the training data says it (64 rows of v2s, 6 of multi_test): only a product's create takes it as a category;
//   - a chat: «чат», «канал», «груповий чат», «групу в телеграмі / вайбері / …»;
//   - a staff member: «працівника», «співробітницю», «персонал», «групу працівників», ru «сотрудника», «работника» (the team is the company's
//     screen, `nav.company_team`, never a customer or a counterparty);
//   - the shop's own requisites, for a counterparty action only: a possessive right before a company word or the requisites («нашої компанії», «свого
//     ФОП», «наші реквізити»), or the requisites said with a counterparty span that is a legal form or a company word and no name («онови реквізити
//     ФОП, у нас новий IBAN»: the counterparty «фоп»); never when «контрагент» is said. The model's `companies.updateLegal` («зміни реквізити нашої
//     компанії») is the action for them and is not touched.
// The object position: right after a command verb (`OBJECT_VERB_STEMS`) or at the start of the utterance, past fillers («мені», «нову», «ще одного»):
// «створи групу Опт для працівників» names a customer group (the staff noun is no object), «клієнта-працівника» is one word. Nothing else changes:
// the confidence, the params and the other needs stay the model's.

type ObjectKind = "product_group" | "category" | "chat" | "staff" | "own_company";
type RecordType = "customer" | "group" | "counterparty" | "product";

// The served actions by the type of record they act on (reads too: «покажи групи товарів» is no list of customer groups).
const ACTION_TYPES: Readonly<Record<string, RecordType>> = {
  "customers.listCustomers": "customer",
  "customers.getCustomer": "customer",
  "customers.createCustomer": "customer",
  "customers.updateCustomer": "customer",
  "customers.setGroup": "customer",
  "customers.archiveCustomer": "customer",
  "customers.restoreCustomer": "customer",
  "customers.deleteCustomer": "customer",
  "customers.listGroups": "group",
  "customers.getGroup": "group",
  "customers.createGroup": "group",
  "customers.updateGroup": "group",
  "customers.deleteGroup": "group",
  "customers.listCounterparties": "counterparty",
  "customers.getCounterparty": "counterparty",
  "customers.createCounterparty": "counterparty",
  "customers.updateCounterparty": "counterparty",
  "customers.deleteCounterparty": "counterparty",
  "catalog.createProduct": "product",
};

// What each type is not: a group of customers may be called a category, a product's create takes no category at all; a staff member is never read
// as a product; the shop's own requisites are only a counterparty's question.
const CONTRADICTS: Readonly<Record<RecordType, ReadonlySet<ObjectKind>>> = {
  customer: new Set(["product_group", "chat", "staff"]),
  group: new Set(["product_group", "chat", "staff"]),
  counterparty: new Set(["product_group", "chat", "staff", "own_company"]),
  product: new Set(["product_group", "category", "chat"]),
};

const COUNTERPARTY = "counterparty";

interface Found {
  readonly kind: ObjectKind;
  readonly words: string;
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function isVerb(word: string): boolean {
  return OBJECT_VERB_STEMS.some((stem) => word.startsWith(stem));
}

// The object said at `at` (past the fillers), or null.
function objectAt(words: readonly string[], at: number): Found | null {
  let index = at;
  while (index < words.length && OBJECT_FILLERS.has(words[index] ?? "")) index++;
  const [first = "", second = "", third = ""] = words.slice(index, index + 3);
  const said = (count: number) => words.slice(index, index + count).join(" ");
  if (GROUP_WORDS.has(first) && GOODS_GENITIVES.has(second)) return { kind: "product_group", words: said(2) };
  if (GOODS_ADJECTIVES.has(first) && GROUP_WORDS.has(second)) return { kind: "product_group", words: said(2) };
  if (CATEGORY_WORDS.has(first) && GOODS_GENITIVES.has(second)) return { kind: "product_group", words: said(2) };
  if (CATEGORY_WORDS.has(first)) return { kind: "category", words: said(1) };
  if (CHAT_WORDS.has(first)) return { kind: "chat", words: said(1) };
  if (CHAT_ADJECTIVES.has(first) && CHAT_WORDS.has(second)) return { kind: "chat", words: said(2) };
  if (GROUP_WORDS.has(first) && CHAT_PLACE_LEADS.has(second) && MESSENGER_STEMS.some((stem) => third.startsWith(stem))) return { kind: "chat", words: said(3) };
  if (STAFF_WORDS.has(first)) return { kind: "staff", words: said(1) };
  if (GROUP_WORDS.has(first) && STAFF_GROUP_GENITIVES.has(second)) return { kind: "staff", words: said(2) };
  return null;
}

// The objects said right after a command verb or at the start.
function objects(words: readonly string[]): Found[] {
  const found: Found[] = [];
  const starts = [0, ...words.flatMap((word, index) => (isVerb(word) ? [index + 1] : []))];
  for (const start of new Set(starts)) {
    const object = objectAt(words, start);
    if (object !== null) found.push(object);
  }
  return found;
}

// The shop's own requisites said to a counterparty action (see above), or null.
function ownCompany(text: string, words: readonly string[], params: Params): Found | null {
  if (COUNTERPARTY_STEMS.some((stem) => text.includes(stem))) return null;
  for (let index = 0; index + 1 < words.length; index++) {
    const [word = "", next = ""] = [words[index], words[index + 1]];
    if (OWN_POSSESSIVES.has(word) && (COMPANY_WORDS.has(next) || REQUISITES_WORDS.has(next))) return { kind: "own_company", words: `${word} ${next}` };
  }
  const span = params[COUNTERPARTY];
  if (typeof span !== "string") return null;
  const named = wordsOf(span);
  if (!named.length || !named.every((word) => LEGAL_FORMS.has(word) || COMPANY_WORDS.has(word))) return null;
  const at = words.findIndex((word) => REQUISITES_WORDS.has(word));
  if (at < 0) return null;
  const after = words.slice(at + 1, at + 1 + named.length).join(" ");
  return { kind: "own_company", words: after === named.join(" ") ? `${words[at] ?? ""} ${after}` : span };
}

// The blocking `unsupported` need on `action` when the words name an object the served action's type contradicts, else null.
export function contradictingObject(action: string, text: string, params: Params): Need | null {
  const type = ACTION_TYPES[action];
  if (type === undefined) return null;
  const words = wordsOf(text);
  const contradicted = CONTRADICTS[type];
  const found = [...objects(words), ...(type === "counterparty" ? [ownCompany(text, words, params)] : [])].find((object) => object !== null && contradicted.has(object.kind));
  return found === undefined || found === null ? null : { path: "action", reason: "unsupported", blocking: true, span: { text: found.words } };
}
