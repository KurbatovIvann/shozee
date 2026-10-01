import { intentOfAction, isV3, type Bundle, type ParamType } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { Decision } from "./command.ts";
import type { ShopRecord } from "./context.ts";
import { BARE_CUSTOMER_WORDS, CREATE_STEMS, FIND_PHRASES, FIND_WORDS, WHOSE_WORDS } from "./lexicon/contacts.ts";
import { NEW_WORDS } from "./lexicon/customers.ts";
import { valueOf } from "./numbers.ts";
import type { Candidate, Need, Param, Ref, SpanParam, Suggestion } from "./result.ts";
import { emailValue } from "./values.ts";

// D94 (owner-approved 2026-09-30, the find rule agreed with Shozee): a customer is found by a phone or an e-mail, and one match opens the record.
//
// 1. `customers.getCustomer` takes `phone` and `email` beside `customer` (the catalogue: one of the three). A contact said for the customer, with no
//    name, is served as **the `customer` ref** `{text, status, by: "phone" | "email", value}` (`contactCustomer`; the addendum, Shozee's answer:
//    the host has one resolver for a name, a phone and an e-mail), not as a param of its own. `value`: a phone's digits as recognised, an e-mail in
//    lower case. By default the ref is `unchecked` and nothing blocks: the host resolves it (one match opens, several are picked from, none offers
//    the create), so there is no `unknown`, `nearest` or `suggest`. Only when the context's customers carry `phones` / `emails` (context v2,
//    optional) is it resolved here: one match `resolved` (`match: "phone"` / `"email"`), several `ambiguous` with the candidates, none `unknown`
//    with the create that would add it; a partial customer list that missed stays `unchecked`.
// 2. The interim rule for the bundles before v3.5 (`createAsFind`), the fourth rule that serves another action than the model's (D84, D85, D92):
//    their `customers.createCustomer` is the only customer action with a phone or an e-mail, so «знайди клієнта з номером 067 123 45 67» is read as
//    a create (0.97–0.98, Shozee SHO-740 family 2). It is served as `customers.getCustomer` with that contact and a non-blocking need
//    `{path: "action", reason: "read_as_find", span: {text: <the contact as said>}}` when all of these hold:
//      a. the model's action is `customers.createCustomer` and the bundle has `customers.getCustomer`;
//      b. the command carries a `phone` or an `email` and nothing else: no `new_name` (a create names its customer), no comment, group or price list,
//         nothing taken from an earlier command, the previous command or the focus, no span the card asks the role of;
//      c. a find word is said: a find or search verb («знайди», «пошукай», «найди», «поищи», `FIND_WORDS`), «хто це» / «кто это» (`FIND_PHRASES`) or
//         «чий / чия / чей» (`WHOSE_WORDS`);
//      d. no word says a record is made: no verb that adds or saves («додай», «створи», «заведи», «запиши», «внеси», «збережи», `CREATE_STEMS`) and
//         no «нового / новий» (`NEW_WORDS`).
//    Anything else keeps the model's create.
// 3. The contact the model tags where the intent has no param for it (`saidContacts`): in its own `customers.getCustomer` of a bundle before v3.5
//    («відкрий клієнта з номером …»), and (the addendum) in any command that takes a customer and has no contact param of its own («замовлення для
//    клієнта з номером … два торти» `orders.create`, «покажи замовлення клієнта з поштою …» `orders.list`). The one phone span (else the one e-mail
//    span) is the customer when the command names none: none said, none from an earlier command, the previous command or the focus, no word that
//    points at one («йому», «цього клієнта»; a bare «клієнту з номером …» is said of the contact and is no pointer). The action is the model's.

export const GET_CUSTOMER = "customers.getCustomer";
const CREATE_CUSTOMER = "customers.createCustomer";
const CUSTOMER = "customer";
const PHONE = "phone";
const EMAIL = "email";
export const CONTACT_PARAMS: readonly string[] = [PHONE, EMAIL];
// The actions a contact span may stand for the customer of: the customer's own, orders and documents. Elsewhere a run of digits the model tagged a
// phone is as likely another number («чий це номер …» read as `delivery.track`: a waybill's).
const CONTACT_DOMAINS: readonly string[] = ["customers.", "orders.", "documents."];
// How many words may stand between the bare customer noun and the contact said for it («клієнту з номером телефону 050 …»).
const CONTACT_REACH = 4;
const MOST_CANDIDATES = 20;
// A phone said in part («номер закінчується на 45 67») is matched by its end: at least four digits, fewer than a whole number.
const SHORTEST_PART = 4;
const WHOLE_PHONE = 9;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// A phone as it is compared: its digits, a Ukrainian number in the national form («+380 67 123 45 67», «80671234567», «67 123 45 67» → «0671234567»).
export function phoneKey(text: string): string {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("380")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("80")) return digits.slice(1);
  if (digits.length === WHOLE_PHONE && !digits.startsWith("0")) return `0${digits}`;
  return digits;
}

export function emailKey(text: string): string {
  return text.trim().toLowerCase();
}

// The customers of a context by their phones and e-mails (context v2 `customers[].phones`, `.emails`).
export class ContactIndex {
  readonly hasPhones: boolean;
  readonly hasEmails: boolean;
  private readonly phones = new Map<string, number[]>();
  private readonly emails = new Map<string, number[]>();

  constructor(records: readonly ShopRecord[]) {
    const add = (index: Map<string, number[]>, key: string, owner: number) => {
      if (!key) return;
      const known = index.get(key);
      if (known === undefined) index.set(key, [owner]);
      else if (!known.includes(owner)) known.push(owner);
    };
    for (const [owner, record] of records.entries()) {
      for (const phone of record.phones ?? []) add(this.phones, phoneKey(phone), owner);
      for (const email of record.emails ?? []) add(this.emails, emailKey(email), owner);
    }
    this.hasPhones = this.phones.size > 0;
    this.hasEmails = this.emails.size > 0;
  }

  // The customers (indices) with this phone; of a part of a number, those whose phone ends with it.
  byPhone(digits: string): readonly number[] {
    const key = phoneKey(digits);
    const whole = this.phones.get(key);
    if (whole !== undefined) return whole;
    if (key.length < SHORTEST_PART || key.length >= WHOLE_PHONE) return [];
    const owners = new Set<number>();
    for (const [phone, found] of this.phones) if (phone.endsWith(key)) for (const owner of found) owners.add(owner);
    return [...owners].sort((left, right) => left - right);
  }

  byEmail(address: string): readonly number[] {
    return this.emails.get(emailKey(address)) ?? [];
  }
}

export interface AsFind {
  readonly decision: Decision;
  // The contact as said, for the `read_as_find` need; null when the model's action stands.
  readonly said: string | null;
  // The types of the contact params, from the create the model read: a bundle before v3.5 has none on `customers.getCustomer`.
  readonly types: Readonly<Record<string, ParamType>>;
}

function findSaid(words: readonly string[]): boolean {
  return words.some((word, at) => FIND_WORDS.has(word) || WHOSE_WORDS.has(word) || FIND_PHRASES.some(([first, second]) => word === first && words[at + 1] === second));
}

function createSaid(words: readonly string[]): boolean {
  return words.some((word) => NEW_WORDS.has(word) || CREATE_STEMS.some((stem) => word.startsWith(stem)));
}

// D94, the interim rule (the conditions above): the model's create that says only a contact, with a find word and no create word, is the find.
export function createAsFind(bundle: Bundle, decision: Decision): AsFind {
  const kept: AsFind = { decision, said: null, types: {} };
  if (decision.action !== CREATE_CUSTOMER || !Object.hasOwn(bundle.intents, GET_CUSTOMER)) return kept;
  const names = Object.keys(decision.params);
  if (!names.length || !names.every((name) => CONTACT_PARAMS.includes(name) && typeof decision.params[name] === "string")) return kept;
  if (Object.keys(decision.refPrevious).length || Object.keys(decision.fromPrevious ?? {}).length || decision.focusPaths?.length || decision.asks?.length) return kept;
  const words = wordsOf(decision.text);
  if (!findSaid(words) || createSaid(words)) return kept;
  const create = intentOfAction(bundle, CREATE_CUSTOMER).intent.params;
  const types = Object.fromEntries(names.flatMap((name) => (Object.hasOwn(create, name) ? [[name, create[name] ?? ""] as const] : [])));
  const said = decision.params[names[0] ?? ""];
  return { decision: { ...decision, action: intentOfAction(bundle, GET_CUSTOMER).action }, said: typeof said === "string" ? said : null, types };
}

export interface Said {
  readonly decision: Decision;
  readonly types: Readonly<Record<string, ParamType>>;
  // The contact params that stand for the customer the command takes (`contactCustomer` makes the `customer` ref of the first).
  readonly standing: readonly string[];
  // The bare «клієнту» the contact was said with is no pointer at a record of the host's: no `context` ref for it.
  readonly unpointed: boolean;
}

// D94 (3) and the addendum: the contact span the model tagged in a command that takes a customer and says none, for an intent with no contact param
// of its own (`customers.getCustomer` of a bundle before v3.5, `orders.create`, `orders.list`, `documents.createFromOrder`, `customers.deleteCustomer`
// …; never `customers.createCustomer` / `updateCustomer`, a shipment or a share, whose phone is the record's own; only the actions of `CONTACT_DOMAINS`, and beyond `customers.getCustomer` only a v3 bundle). `pointed`: the params a deictic
// word points at (`command.ts` `deictics`).
export function saidContacts(bundle: Bundle, decision: Decision, pointed: ReadonlyMap<string, string>): Said {
  const kept: Said = { decision, types: {}, standing: [], unpointed: false };
  const own = intentOfAction(bundle, decision.action).intent.params;
  if (own[CUSTOMER] !== CUSTOMER || !CONTACT_DOMAINS.some((domain) => decision.action.startsWith(domain))) return kept;
  const bound = decision.fromPrevious ?? {};
  const taken = (name: string) => decision.params[name] !== undefined || Object.hasOwn(decision.refPrevious, name) || Object.hasOwn(bound, name);
  if (decision.params[CUSTOMER] !== undefined || Object.hasOwn(decision.refPrevious, CUSTOMER)) return kept;
  // `customers.getCustomer` with its contact param read (a v3.5 bundle's own, or the interim rule's): that contact stands for the customer.
  const said = CONTACT_PARAMS.filter((name) => typeof decision.params[name] === "string");
  if (decision.action === GET_CUSTOMER && said.length && !Object.hasOwn(bound, CUSTOMER)) return { ...kept, standing: said };
  // Beyond `customers.getCustomer`, only a v3 bundle: a v2 catalogue's `documents.share` has no recipient param, so the phone or the e-mail the
  // document goes to («чек СМС на 067 …») would be read as its customer.
  if (decision.action !== GET_CUSTOMER && !isV3(bundle)) return kept;
  if (CONTACT_PARAMS.some((name) => Object.hasOwn(own, name) || taken(name))) return kept;
  // The focus (D88) claimed something else of the command (an order it continues, the action's type): not a plain command with a contact.
  if ((decision.focusPaths ?? []).some((path) => path !== CUSTOMER)) return kept;
  const found = CONTACT_PARAMS.flatMap((name) => {
    const spans = decision.spans.filter((span) => span.kind === name);
    const [only] = spans;
    return only !== undefined && new Set(spans.map((span) => span.text)).size === 1 ? [[name, only] as const] : [];
  });
  const [first] = found;
  if (first === undefined) return kept;
  const [name, span] = first;
  // A word said for the customer: the deictic the host fills (`pointed`), or the reference word the focus bound or asked about. Only the bare
  // «клієнту» said right before the contact («клієнту з телефоном …») gives way to it; «йому», «цьому клієнту» are the customer.
  const focusRef = bound[CUSTOMER];
  const focusWord = focusRef !== undefined && !Array.isArray(focusRef) && "text" in focusRef ? focusRef.text : decision.focusNeeds?.find((need) => need.path === CUSTOMER)?.span?.text;
  const claimed = Object.hasOwn(bound, CUSTOMER) || (decision.focusPaths ?? []).includes(CUSTOMER);
  const word = claimed ? focusWord : pointed.get(CUSTOMER);
  if (claimed && word === undefined) return kept;
  if (word !== undefined && !(BARE_CUSTOMER_WORDS.has(word) && saidBefore(decision.text, word, span.start))) return kept;
  const { [CUSTOMER]: _bound, ...others } = bound;
  const unbound: Decision = !claimed
    ? decision
    : { ...decision, fromPrevious: others, focusNeeds: (decision.focusNeeds ?? []).filter((need) => need.path !== CUSTOMER), focusPaths: (decision.focusPaths ?? []).filter((path) => path !== CUSTOMER) };
  return { decision: { ...unbound, params: { ...unbound.params, [name]: span.text } }, types: { [name]: name }, standing: [name], unpointed: word !== undefined };
}

// Is `word` said within `CONTACT_REACH` words before the character `at` («клієнту з телефоном 050 …»)?
function saidBefore(text: string, word: string, at: number): boolean {
  return wordsOf(text.slice(0, at)).slice(-CONTACT_REACH).includes(word);
}

export interface Contacted {
  // The customer the contact stands for: resolved, ambiguous or unknown against the context's contacts; `unchecked` when the host resolves it.
  readonly customer: Ref;
  // The contact param the ref was made of: it is served as the ref, not as a param of its own.
  readonly taken: string;
  readonly needs: readonly Need[];
}

function spanOf(param: Param | undefined): SpanParam | null {
  return param !== undefined && !Array.isArray(param) && "text" in param && !("status" in param) && !("attrs" in param) ? (param as SpanParam) : null;
}

function candidate(record: ShopRecord): Candidate {
  return { id: record.id, name: record.name };
}

// The contact as the host looks it up: a phone's digits as recognised (no country code guessed), an e-mail in lower case (said in words: read).
export function contactValue(kind: string, text: string): string {
  if (kind === PHONE) {
    const digits = valueOf(PHONE, text);
    return typeof digits === "string" && digits ? digits : text.replace(/\D/g, "");
  }
  return (emailValue(text) ?? text).toLowerCase();
}

// D94: the customer a command names by a phone or an e-mail (`standing`: its contact params that stand for the customer), as the `customer` ref
// `{text, status, by, value}`: `by` the kind of contact, `value` as `contactValue` writes it. Against a context whose customers carry contacts of
// that kind the ref is resolved, ambiguous or unknown; otherwise it is `unchecked`, with no need: the host resolves it. Null when a customer is named
// (the name decides) or no contact stands for one.
export function contactCustomer(bundle: Bundle, params: Readonly<Record<string, Param>>, context: CompiledContext | null, standing: readonly string[]): Contacted | null {
  if (Object.hasOwn(params, CUSTOMER)) return null;
  const said = standing.flatMap((name) => {
    const span = spanOf(params[name]);
    return span === null ? [] : [{ name, span, value: contactValue(name, span.text) }];
  });
  const [first] = said;
  if (first === undefined) return null;
  const ref = (contact: typeof first, status: Ref["status"]): Ref => ({ text: contact.span.text, status, by: contact.name === EMAIL ? "email" : "phone", value: contact.value, ...(contact.span.confidence === undefined ? {} : { confidence: contact.span.confidence }) });
  const unchecked: Contacted = { customer: ref(first, "unchecked"), taken: first.name, needs: [] };
  const records = context?.records ?? null;
  const list = records?.lists.customers ?? null;
  const index = records?.contacts ?? null;
  if (records === null || list === null || index === null) return unchecked;
  // The customers each contact names, of the contacts the context can check: it has contacts of that kind, and the value reads as one.
  const checked = said.flatMap((contact) => {
    if (contact.name === PHONE) return index.hasPhones && phoneKey(contact.value).length >= SHORTEST_PART ? [[contact, index.byPhone(contact.value)] as const] : [];
    return index.hasEmails ? [[contact, index.byEmail(contact.value)] as const] : [];
  });
  const [probe] = checked;
  if (probe === undefined) return unchecked;
  const found = checked.filter(([, owners]) => owners.length > 0);
  const [head, ...rest] = found.map(([, owners]) => owners);
  // A phone and an e-mail: the customers both name; two contacts of two different customers are no one customer, and both are the candidates.
  const common = (head ?? []).filter((owner) => rest.every((owners) => owners.includes(owner)));
  const owners = common.length ? common : [...new Set(found.flatMap(([, each]) => each))].sort((left, right) => left - right);
  // The ref is the contact that named someone, else the first the context could check.
  const chosen = found[0]?.[0] ?? probe[0];
  const [only] = owners;
  const record = only === undefined ? undefined : list.records[only];
  if (owners.length === 1 && record !== undefined) {
    const base = ref(chosen, "resolved");
    return { customer: { ...base, id: record.id, name: record.name, ...(base.by === undefined ? {} : { match: base.by }) }, taken: chosen.name, needs: [] };
  }
  if (owners.length > 1) {
    const candidates = owners.flatMap((owner) => {
      const each = list.records[owner];
      return each === undefined ? [] : [candidate(each)];
    });
    const listed = candidates.length > MOST_CANDIDATES ? { candidates: candidates.slice(0, MOST_CANDIDATES), truncated: true as const } : { candidates };
    return { customer: { ...ref(chosen, "ambiguous"), ...listed }, taken: chosen.name, needs: [{ path: CUSTOMER, reason: "ambiguous", blocking: true }] };
  }
  // A partial list that missed says nothing: the host resolves the contact.
  if (records.shop.partial.has("customers")) return unchecked;
  // Nobody has it, and the context holds the customers' contacts: the create that would add a customer with the contact (D78's `suggest`).
  const create = Object.hasOwn(bundle.intents, CREATE_CUSTOMER) ? intentOfAction(bundle, CREATE_CUSTOMER) : null;
  const given = Object.fromEntries(said.filter((contact) => create !== null && Object.hasOwn(create.intent.params, contact.name)).map((contact) => [contact.name, { text: contact.span.text, value: contact.value }]));
  const suggest: Suggestion | null = create === null ? null : { action: create.action, params: given };
  return { customer: { ...ref(chosen, "unknown"), ...(suggest === null ? {} : { suggest }) }, taken: chosen.name, needs: [{ path: CUSTOMER, reason: "unknown", blocking: true }] };
}
