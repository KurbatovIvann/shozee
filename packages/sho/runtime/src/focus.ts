import { intentOfAction, isV3, listItemType, type Bundle, type Intent, type ParamType } from "./bundle.ts";
import type { Decision } from "./command.ts";
import { InputError } from "./errors.ts";
import { nameGender, type Gender } from "./gender.ts";
import {
  CONTINUATION_LEADS,
  CONTINUATION_MORE,
  DEICTICS,
  FOCUS_CONTAINER_PARAMS,
  FOCUS_CONTAINERS,
  FOCUS_HERE,
  FOCUS_NEW,
  FOCUS_NOUNS,
  FOCUS_PARAM_TYPES,
  FOCUS_PREPOSITIONS,
  FOCUS_THIS,
  FOCUS_ARCHIVE_PHRASES,
  FOCUS_VERBS,
  PRONOUN_FORMS,
  type FocusType,
  type FocusVerb,
  type PronounForm,
} from "./lexicon/references.ts";
import { RENAME_VERBS } from "./lexicon/customers.ts";
import { nominativeName } from "./nominative.ts";
import { isLines } from "./params.ts";
import { REFINE } from "./refine.ts";
import type { CommandV2, Creates, Need, Param, Ref } from "./result.ts";

// D88 (sho-api-v2.md §8.18): references across turns to a record the host keeps in focus. The host (the app, not the runtime: the runtime stays
// stateless) passes `RunOptions.focus`, the records the person just created, opened, was shown or named, newest first; a reference word said for a record
// the command takes and has none of («для неї», «туди», «цю групу», «цьому контрагенту») binds to the one live focus entry of the param's type that
// agrees with it (D90: by the conversation, not the clock), several that fit are `ambiguous` (the card asks, never the newest), and none (no entry,
// another type or gender) is a blocking need `reference`: a said reference is never dropped. A host that passes no `focus` gets D79's pronouns from
// `previous` (`pronouns.ts`), unchanged; a host that passes one (even empty) gets these rules and `creates` on its create commands.
//
// D89 (sho-api-v2.md §8.19, owner decisions of 2026-09-30): (1) a bare verb said of a record in focus, with no type noun («видали її», «заархівуй
// його», «перейменуй її на …», «відкрий його», «додай йому телефон …») is that verb's action for the referent's type (`byFocusType`): «видали її» after
// a customer is `customers.deleteCustomer`, never `orders.cancel`; the card gets the non-blocking need `read_as_focus_type`. A type the verb has no
// action for, or referents of two types, ask. (2) The chat beats the screen: a record the chat created, named or showed stands before one the person
// only opened on a screen (`how: "opened"`), so two records ask only when they stand alike; «цей / сюди» still prefer the on-screen record among them.
//
// D90 (sho-api-v2.md §8.20, owner decisions of 2026-09-30): how long a record stays in focus is a matter of the conversation, not of time; the runtime
// reads no clock. The host counts the person's commands since each entry was last touched (`turns`) and marks the entries of an earlier conversation
// (`earlier`). An entry is **live** while one of the last three commands touched it (`turns` ≤ FOCUS_LIVE), or while it is on screen; only live
// entries bind silently. When no live entry fits, the most recently touched one that fits is **offered**: its ref with the blocking need
// `check_reference` («Для <name>?», one tap confirms). An entry of an earlier conversation is never bound silently. Cancelled or archived records
// (`closed`) fit only a restore. A record the chat said stands before one only opened by hand (D89), unless the person opened that one by hand after the
// chat's mention and it is on screen: then the card asks between them. A record of the type the conversation touched and the host has no id for since
// (a marker: an entry with no id, such as a long list shown or a create the API refused) turns a would-be silent bind into an offer.

export type { FocusType };
export type FocusHow = "created" | "opened" | "shown" | "named" | "listed";

export interface FocusEntry {
  readonly type: FocusType;
  // The host's id: the runtime returns it in the ref and never checks it. "" on a marker (D90: sent with no id: records of the type the conversation
  // touched that the host has no id for, a long list shown or a create the API refused).
  readonly id: string;
  // As stored (an order's number as the card says it); a person's gender is read from it when `gender` is absent.
  readonly name: string;
  readonly how: FocusHow;
  // D90: informational only (logs): when it entered focus, as D88 had it. The runtime never reads it.
  readonly at?: string | number;
  // D90: the person's commands since the entry was last touched (0: the previous command or a later tap touched it). Absent: a D88 host (see `tierOf`).
  readonly turns?: number;
  // D90: false on a record the person only opened by hand and nobody said in this conversation; by default `how !== "opened"`.
  readonly said?: boolean;
  // D90: touched in an earlier conversation (the host's call: the app reopened, the next day, …): never bound silently, only offered.
  readonly earlier?: boolean;
  // D90: cancelled or archived (restorable): it fits only a restore.
  readonly closed?: boolean;
  // D90: on a list marker, how many records the list showed (informational).
  readonly count?: number;
  // The one record the open screen shows: «сюди», «цей …» prefer it; on screen it stays live.
  readonly screen?: boolean;
  readonly gender?: Gender;
  // An order's customer id: a customer reference with no customer in focus takes it; `customerName` is the name the card shows for it.
  readonly customer?: string;
  readonly customerName?: string;
}

// D90: an entry is live while one of the last FOCUS_LIVE + 1 commands touched it (owner: three); the host keeps at most MOST_FOCUS entries (the runtime
// reads the first ones).
export const FOCUS_LIVE = 2;
// D90: a record that has missed this many commands leaves the race for a pronoun when the chat has since said another record of its type (supersession).
const SUPERSEDED = 2;
export const MOST_FOCUS = 8;

const TYPES: ReadonlySet<string> = new Set<FocusType>(["customer", "group", "order", "product", "price_list", "counterparty"]);
const HOWS: ReadonlySet<string> = new Set<FocusHow>(["created", "opened", "shown", "named", "listed"]);
const GENDERS: ReadonlySet<string> = new Set<Gender>(["feminine", "masculine"]);
// The grammatical gender of a record type's noun, for a pronoun: «група» is «її», «замовлення», «прайс» «його»; a product and a person or a firm by name.
const TYPE_GENDER: Readonly<Record<FocusType, Gender | null>> = { customer: null, group: "feminine", order: "masculine", product: null, price_list: "masculine", counterparty: null };
const CUSTOMER: FocusType = "customer";
const NO_RECORD_KINDS: ReadonlySet<string> = new Set(["nav", "ui", "none"]);
const ORDER_CREATE = "orders.create";
const ORDER_UPDATE = "orders.update";
const ORDER_NUMBER = "order_number";
const ITEMS = "items";
const ACTION = "action";
const LOOSE_PLACE = "там";
const BARE_NOUN_DEICTICS: ReadonlySet<string> = new Set(DEICTICS.filter(([phrase, target]) => target === "customer" && !phrase.includes(" ") && !PRONOUN_FORMS.has(phrase)).map(([phrase]) => phrase));

type Json = Readonly<Record<string, unknown>>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flag(value: unknown, where: string, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new InputError("input_focus", `${where}.${name} is not a boolean`);
  return value;
}

function count(value: unknown, where: string, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new InputError("input_focus", `${where}.${name} is not a whole number of 0 or more`);
  return value;
}

function entryOf(value: unknown, index: number): FocusEntry {
  const where = `focus[${index}]`;
  if (!isJson(value)) throw new InputError("input_focus", `${where} is not an object`);
  const { type, id, name, how, at, screen, gender, customer, customerName } = value;
  if (typeof type !== "string" || !TYPES.has(type)) throw new InputError("input_focus", `${where}.type is not one of ${[...TYPES].join(", ")}`);
  if (typeof how !== "string" || !HOWS.has(how)) throw new InputError("input_focus", `${where}.how is not one of ${[...HOWS].join(", ")}`);
  // D90: a marker (a long list shown, a create the API refused) carries no id and maybe no name.
  const marker = id === undefined || id === null || id === "";
  if (!marker && !(typeof id === "string" && id !== "") && !(typeof id === "number" && Number.isFinite(id))) throw new InputError("input_focus", `${where}.id is not a string`);
  if (!(marker && (name === undefined || name === null)) && typeof name !== "string") throw new InputError("input_focus", `${where}.name is not a string`);
  if (at !== undefined && at !== null && typeof at !== "string" && !(typeof at === "number" && Number.isFinite(at))) throw new InputError("input_focus", `${where}.at is not an ISO time or Unix milliseconds`);
  if (screen !== undefined && typeof screen !== "boolean") throw new InputError("input_focus", `${where}.screen is not a boolean`);
  if (gender !== undefined && gender !== null && (typeof gender !== "string" || !GENDERS.has(gender))) throw new InputError("input_focus", `${where}.gender is not feminine or masculine`);
  if (customer !== undefined && customer !== null && typeof customer !== "string") throw new InputError("input_focus", `${where}.customer is not a string`);
  if (customerName !== undefined && customerName !== null && typeof customerName !== "string") throw new InputError("input_focus", `${where}.customerName is not a string`);
  const turns = count(value["turns"], where, "turns");
  const listed = count(value["count"], where, "count");
  const said = flag(value["said"], where, "said");
  const earlier = flag(value["earlier"], where, "earlier");
  const closed = flag(value["closed"], where, "closed");
  return {
    type: type as FocusType,
    id: marker ? "" : String(id),
    name: typeof name === "string" ? name : "",
    how: how as FocusHow,
    ...(typeof at === "string" || typeof at === "number" ? { at } : {}),
    ...(turns === undefined ? {} : { turns }),
    ...(said === undefined ? {} : { said }),
    ...(earlier === true ? { earlier: true } : {}),
    ...(closed === true ? { closed: true } : {}),
    ...(listed === undefined ? {} : { count: listed }),
    ...(screen === true ? { screen: true } : {}),
    ...(typeof gender === "string" ? { gender: gender as Gender } : {}),
    ...(typeof customer === "string" ? { customer } : {}),
    ...(typeof customerName === "string" ? { customerName } : {}),
  };
}

// The focus a host passes: a list of entries, newest first; the runtime reads the first MOST_FOCUS.
export function parseFocus(value: unknown): FocusEntry[] {
  if (!Array.isArray(value)) throw new InputError("input_focus", "focus is not a list");
  return value.slice(0, MOST_FOCUS).map(entryOf);
}

interface Candidate {
  // The entry's index in the host's list (the ref's `focus`).
  readonly index: number;
  readonly entry: FocusEntry;
  // The first entry of its type in the list: the record of that type the conversation touched last.
  readonly newest: boolean;
}

// What the host's list holds: its records, one per record (the first of a type and id), and its markers (records of a type with no id).
interface Held {
  readonly records: readonly Candidate[];
  readonly markers: readonly Candidate[];
}

function isMarker(entry: FocusEntry): boolean {
  return entry.id === "";
}

function heldOf(focus: readonly FocusEntry[]): Held {
  const seen = new Set<string>();
  const types = new Set<FocusType>();
  const records: Candidate[] = [];
  const markers: Candidate[] = [];
  for (const [index, entry] of focus.slice(0, MOST_FOCUS).entries()) {
    if (isMarker(entry)) {
      markers.push({ index, entry, newest: false });
      continue;
    }
    const key = `${entry.type} ${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({ index, entry, newest: !types.has(entry.type) });
    types.add(entry.type);
  }
  return { records, markers };
}

// D89 / D90: a record the conversation said (created, named, shown or listed by a command); `said: false` or a hand-opened screen (`how: "opened"`) not.
function saidOf(candidate: Candidate): boolean {
  return candidate.entry.said ?? candidate.entry.how !== "opened";
}

// D90: how an entry may bind.
// - `live`: binds alone. On screen now; or said and touched by one of the last three commands (`turns` ≤ FOCUS_LIVE); or, from a host that sends no
//   `turns` (D88), the newest entry of its type.
// - `shadow` (only a D88 host's older entries of a type, whose freshness the runtime cannot tell): competes with the live ones (two ask, as D88) but never
//   binds alone: alone it is offered.
// - `offer`: an earlier conversation's, one that has missed three commands or more, one opened by hand and no longer on screen: never bound silently.
type Tier = "live" | "shadow" | "offer";

function tierOf(candidate: Candidate): Tier {
  const { entry } = candidate;
  if (entry.earlier === true) return "offer";
  if (entry.screen === true) return "live";
  if (entry.turns === undefined) return candidate.newest ? "live" : "shadow";
  if (!saidOf(candidate)) return "offer";
  return entry.turns <= FOCUS_LIVE ? "live" : "offer";
}

type Resolution =
  | { readonly kind: "bind"; readonly candidate: Candidate }
  | { readonly kind: "offer"; readonly candidate: Candidate }
  | { readonly kind: "ask"; readonly candidates: readonly Candidate[] }
  | { readonly kind: "none" };

// D90: which of the entries that fit a reference it binds (all of them agree with it and are of a type the param or the verb takes; a closed record only
// for a restore). In order:
// 1. The competing entries: live and shadow. Among those the conversation said, a pronoun or a place word drops one that has missed two commands or more
//    when another said record of its type was touched since (supersession: the talk moved on to it).
// 2. The chat beats the screen (D89): the said ones stand first; a record opened by hand stands with them only when it is on screen and was opened after
//    the newest of them (owner: «перепитати»). With none said, the hand-opened ones on screen.
// 3. «цей / сюди» prefer the one on screen, «нового» the created one (D88).
// 4. One: it binds, unless it is a D88 host's older entry standing alone, or a marker of its type is newer (a list shown, a create refused since):
//    then it is offered. Several: the card asks (never the newest). None: the most recently touched entry that is only offerable is offered; two touched alike ask.
function resolve(fits: readonly Candidate[], markers: readonly Candidate[], reference: Reference): Resolution {
  const competing = fits.filter((candidate) => tierOf(candidate) !== "offer");
  const pronoun = reference.kind !== "this" && reference.kind !== "new";
  const superseded = (candidate: Candidate, said: readonly Candidate[]): boolean => {
    const turns = candidate.entry.turns;
    if (!pronoun || turns === undefined || turns < SUPERSEDED) return false;
    return said.some((other) => other.entry.type === candidate.entry.type && other.entry.turns !== undefined && other.entry.turns < turns);
  };
  const saidAll = competing.filter(saidOf);
  const said = saidAll.filter((candidate) => !superseded(candidate, saidAll));
  let standing: readonly Candidate[];
  if (said.length) {
    const newestSaid = Math.min(...said.map((candidate) => candidate.index));
    standing = [...said, ...competing.filter((candidate) => !saidOf(candidate) && candidate.entry.screen === true && candidate.index < newestSaid)];
  } else {
    standing = competing.filter((candidate) => !saidOf(candidate));
  }
  const preferred = reference.kind === "new" ? standing.filter((candidate) => candidate.entry.how === "created") : reference.kind === "this" || reference.here === true ? standing.filter((candidate) => candidate.entry.screen === true) : [];
  const chosen = preferred.length ? preferred : standing;
  const [only] = chosen;
  if (chosen.length === 1 && only !== undefined) {
    const markedSince = markers.some((marker) => marker.entry.type === only.entry.type && marker.index < only.index);
    // A D88 host's older entry is offered when nothing else stands with it (a description that picks it among others binds it, as D88).
    const unsure = tierOf(only) === "shadow" && standing.length === 1;
    return unsure || markedSince ? { kind: "offer", candidate: only } : { kind: "bind", candidate: only };
  }
  if (chosen.length > 1) return { kind: "ask", candidates: [...chosen].sort((left, right) => left.index - right.index) };
  const offered = fits.filter((candidate) => tierOf(candidate) === "offer");
  const [best] = offered;
  if (best === undefined) return { kind: "none" };
  const alike = offered.filter((candidate) => candidate !== best && candidate.entry.earlier === best.entry.earlier && candidate.entry.turns !== undefined && candidate.entry.turns === best.entry.turns);
  return alike.length ? { kind: "ask", candidates: [best, ...alike] } : { kind: "offer", candidate: best };
}

// A restore is the one action a closed record fits.
const RESTORES: ReadonlySet<string> = new Set(["customers.restoreCustomer", "catalog.restoreProduct"]);

function restorable(candidate: Candidate, action: string): boolean {
  return candidate.entry.closed !== true || RESTORES.has(action);
}

function genderOf(entry: FocusEntry): Gender | null {
  if (entry.gender !== undefined) return entry.gender;
  return entry.type === CUSTOMER || entry.type === "counterparty" ? nameGender(entry.name) : TYPE_GENDER[entry.type];
}

// A pronoun agrees with an entry when either's gender is unknown or they are the same.
function agrees(form: PronounForm | null, entry: FocusEntry): boolean {
  if (form === null || form.gender === null) return true;
  const gender = genderOf(entry);
  return gender === null || gender === form.gender;
}

type Kind = "this" | "new" | "container" | "dative" | "object" | "prepositional";

interface Reference {
  readonly kind: Kind;
  readonly text: string;
  readonly type?: FocusType;
  readonly form?: PronounForm;
  readonly here?: boolean;
}

function nounType(word: string | undefined): FocusType | null {
  if (word === undefined) return null;
  return FOCUS_NOUNS.find(([stem]) => word.startsWith(stem))?.[1] ?? null;
}

// Whether a model span holds the words: then they are part of what the model read, not a pointer.
function spanned(decision: Decision, phrase: string): boolean {
  return decision.spans.some((span) => ` ${span.text.toLowerCase()} `.includes(` ${phrase} `));
}

// The reference words of the command's text no model span holds, the definite descriptions first, then the places, then the pronouns as said.
function referencesOf(decision: Decision): Reference[] {
  const words = decision.text.toLowerCase().split(/\s+/).filter(Boolean);
  const used = new Set<number>();
  const described: Reference[] = [];
  const places: Reference[] = [];
  const pronouns: Reference[] = [];
  words.forEach((word, at) => {
    const type = nounType(words[at + 1]);
    if ((FOCUS_THIS.has(word) || FOCUS_NEW.has(word)) && type !== null) {
      const text = `${word} ${words[at + 1]}`;
      used.add(at).add(at + 1);
      if (!spanned(decision, text)) described.push({ kind: FOCUS_NEW.has(word) ? "new" : "this", text, type });
    }
  });
  words.forEach((word, at) => {
    if (used.has(at)) return;
    if (BARE_NOUN_DEICTICS.has(word)) {
      if (!spanned(decision, word)) described.push({ kind: "this", text: word, type: CUSTOMER });
      return;
    }
    if (FOCUS_CONTAINERS.has(word)) {
      if (!spanned(decision, word)) places.push({ kind: "container", text: word, here: FOCUS_HERE.has(word) });
      return;
    }
    const form = PRONOUN_FORMS.get(word);
    if (form === undefined || form.number !== "singular" || spanned(decision, word)) return;
    const before = words[at - 1];
    const prepositional = !form.dative && before !== undefined && FOCUS_PREPOSITIONS.has(before) && !used.has(at - 1);
    pronouns.push({ kind: form.dative ? "dative" : prepositional ? "prepositional" : "object", text: prepositional ? `${before} ${word}` : word, form });
  });
  return [...described, ...places, ...pronouns];
}

export interface FocusClaim {
  readonly refs: Readonly<Record<string, Param>>;
  readonly needs: readonly Need[];
  readonly paths: readonly string[];
}

// «і ще 2 круасани» (rule 8, as narrow as D84): the model's new order with only items, said with «і / а / и ще», «ещё», after an order the host created
// (the newest order of the host's list, not closed), is that order's `orders.update {order_number, items}` with a non-blocking `read_as_update` need. The
// model's own `orders.update` with only items and no order, said so, takes that order the same way, with no need (the action is the model's). D90: the
// order is bound only when the previous command touched it (`turns` 0; from a host that sends no `turns`, the first entry of the list) in this
// conversation; else the update is served with that order offered (the blocking `check_reference`), never a silent new order nor a silent update.
function continued(bundle: Bundle, decision: Decision, held: Held): Decision | null {
  if (!Object.hasOwn(bundle.intents, ORDER_UPDATE)) return null;
  const update = intentOfAction(bundle, ORDER_UPDATE);
  if (decision.action !== ORDER_CREATE && decision.action !== update.action) return null;
  if (!Object.hasOwn(update.intent.params, ORDER_NUMBER) || !Object.hasOwn(update.intent.params, ITEMS)) return null;
  const names = Object.keys(decision.params);
  if (names.length !== 1 || names[0] !== ITEMS || !isLines(decision.params[ITEMS]) || Object.keys(decision.refPrevious).length) return null;
  const words = decision.text.split(/\s+/).filter(Boolean);
  let at = 0;
  while (at < 2 && CONTINUATION_LEADS.has(words[at] ?? "")) at++;
  if (!CONTINUATION_MORE.has(words[at] ?? "")) return null;
  const order = held.records.find((candidate) => candidate.entry.type === "order");
  if (order === undefined || order.entry.how !== "created" || order.entry.closed === true) return null;
  const now = order.entry.earlier !== true && (order.entry.turns === undefined ? order.index === 0 : order.entry.turns === 0);
  const cue = words.slice(0, at + 1).join(" ");
  const ref: Ref = { text: cue, status: "context", id: order.entry.id, name: order.entry.name, focus: order.index };
  const checks: Need[] = now ? [] : [{ path: ORDER_NUMBER, reason: "check_reference", blocking: true, span: { text: cue } }];
  if (decision.action === update.action) return { ...decision, fromPrevious: { [ORDER_NUMBER]: ref }, focusNeeds: checks, focusPaths: [ORDER_NUMBER] };
  const need: Need = { path: "action", reason: "read_as_update", blocking: false, span: { text: cue } };
  return { ...decision, action: update.action, fromPrevious: { [ORDER_NUMBER]: ref }, focusNeeds: [need, ...checks], focusPaths: [ORDER_NUMBER] };
}

// D89 (1): the action of each verb for each record type (intents v3; D6: «видали товар» archives it, «видали замовлення» cancels it); a type with no
// entry has no such action and the card asks. `edit` is the contact edit said to a pronoun («додай йому телефон …»): a customer's or a firm's.
type Family = FocusVerb | "edit";
const FAMILIES: Readonly<Record<Family, Partial<Record<FocusType, string>>>> = {
  delete: { customer: "customers.deleteCustomer", group: "customers.deleteGroup", counterparty: "customers.deleteCounterparty", price_list: "pricing.deletePriceList", product: "catalog.archiveProduct", order: "orders.cancel" },
  archive: { customer: "customers.archiveCustomer", product: "catalog.archiveProduct" },
  restore: { customer: "customers.restoreCustomer", product: "catalog.restoreProduct" },
  rename: { customer: "customers.updateCustomer", group: "customers.updateGroup", counterparty: "customers.updateCounterparty", product: "catalog.updateProduct", price_list: "pricing.updatePriceList" },
  open: { customer: "customers.getCustomer", group: "customers.getGroup", counterparty: "customers.getCounterparty", product: "catalog.getProduct", price_list: "pricing.getPriceList", order: "orders.get" },
  edit: { customer: "customers.updateCustomer", counterparty: "customers.updateCounterparty" },
};
// What the contact edit carries: a phone, an email, a comment (a customer's and a firm's alike).
const EDITED: ReadonlySet<string> = new Set(["phone", "email", "comment"]);

function recordType(bundle: Bundle, intent: Intent, name: string): FocusType | null {
  const declared: ParamType = intent.params[name] ?? "";
  return FOCUS_PARAM_TYPES.get(listItemType(bundle, declared) ?? declared) ?? null;
}

// The verb the words say, by family: an archive said as a place («в архів», «з архіву») first, then the first verb word.
function verbOf(words: readonly string[]): FocusVerb | null {
  const text = ` ${words.join(" ")} `;
  const place = FOCUS_ARCHIVE_PHRASES.find(([phrase]) => text.includes(` ${phrase} `));
  if (place !== undefined) return place[1];
  for (const word of words) {
    const verb = FOCUS_VERBS.get(word) ?? (RENAME_VERBS.has(word) ? "rename" : undefined);
    if (verb !== undefined) return verb;
  }
  return null;
}

interface Typed {
  readonly decision: Decision;
  // The reference the rule read; `withFocus` binds nothing more for it.
  readonly reference: Reference;
}

// D89 (1): the owner's «видали» rule. All of these must hold: the words say no record type («клієнта», «групу», … `FOCUS_NOUNS`: the noun decides);
// one reference word is said, an object pronoun after a verb of a family («видали її», «заархівуй його», «перейменуй її на …», «відкрий його», «в
// архів»), or an object or dative pronoun to a contact edit («додай йому телефон …»: the model's `updateCustomer` / `updateCounterparty` with only a
// phone, an email or a comment); the model's action is one of that family's, with its record params empty. The focus entries the pronoun
// agrees with, as D90 resolves them (`resolve`: live first, the chat's first), then decide: none leaves the command to the rules below (it asks); two
// types ask (a blocking
// `ambiguous` need on `action`); one type the family has no action for asks (`reference` on `action`, as D88); one type whose action is the model's
// leaves it to the rules below; else the command is that type's action with the model's params (when it takes them all) and the referent bound, and
// the non-blocking need `{path: "action", reason: "read_as_focus_type", span}` (D90: an offered referent adds the blocking `check_reference` on its
// param). The confidence and the aux heads stay the model's (D84).
function byFocusType(bundle: Bundle, decision: Decision, held: Held, references: readonly Reference[]): Typed | null {
  const words = decision.text.toLowerCase().split(/\s+/).filter(Boolean);
  const [reference] = references;
  if (references.length !== 1 || reference === undefined || words.some((word) => nounType(word) !== null)) return null;
  const verb = verbOf(words);
  const edited = Object.keys(decision.params);
  const edit = verb === null && edited.length > 0 && edited.every((name) => EDITED.has(name));
  if (verb === null && !edit) return null;
  if (!(reference.kind === "object" || (edit && reference.kind === "dative"))) return null;
  const family = FAMILIES[verb ?? "edit"];
  if (!Object.values(family).includes(decision.action)) return null;
  const { intent } = intentOfAction(bundle, decision.action);
  const said = (name: string) => Object.hasOwn(decision.params, name) || Object.hasOwn(decision.refPrevious, name);
  if (Object.keys(intent.params).some((name) => recordType(bundle, intent, name) !== null && said(name))) return null;
  // A contact edit is only a customer's or a firm's (a group in focus is no «їй» of a phone); a verb is any record's, so a type it has no action for asks.
  const restoring = verb === "restore";
  const fits = held.records.filter((candidate) => agrees(reference.form ?? null, candidate.entry) && (verb !== null || Object.hasOwn(family, candidate.entry.type)) && (candidate.entry.closed !== true || restoring));
  const resolution = resolve(fits, held.markers, reference);
  if (resolution.kind === "none") return null;
  const referents = resolution.kind === "ask" ? resolution.candidates : [resolution.candidate];
  const types = [...new Set(referents.map((candidate) => candidate.entry.type))];
  const [type] = types;
  if (type === undefined) return null;
  const span = { text: reference.text };
  // The pronoun is read here: no D70 `context` ref of it on another record param either.
  const records = (of: Intent) => Object.keys(of.params).filter((name) => recordType(bundle, of, name) !== null);
  const asks = (reason: "ambiguous" | "reference"): Typed => ({ decision: { ...decision, focusNeeds: [{ path: ACTION, reason, blocking: true, span }], focusPaths: [ACTION, ...records(intent)] }, reference });
  if (types.length > 1) return asks("ambiguous");
  const member = family[type];
  if (member === undefined || !Object.hasOwn(bundle.intents, member)) return asks("reference");
  const target = intentOfAction(bundle, member);
  if (target.action === decision.action || !edited.every((name) => Object.hasOwn(target.intent.params, name))) return null;
  const slot = Object.keys(target.intent.params).find((name) => recordType(bundle, target.intent, name) === type);
  if (slot === undefined) return null;
  const listed = listItemType(bundle, target.intent.params[slot] ?? "") !== undefined;
  const needs: Need[] = [{ path: ACTION, reason: "read_as_focus_type", blocking: false, span }];
  const { ref, need } = bound(resolution, reference.text, listed ? `${slot}[0]` : slot);
  if (need !== null) needs.push(need);
  const param: Param = listed ? [ref] : ref;
  return { decision: { ...decision, action: target.action, fromPrevious: { ...(decision.fromPrevious ?? {}), [slot]: param }, focusNeeds: needs, focusPaths: records(target.intent) }, reference };
}

// The ref a resolution gives a param (`path` is the need's), and the blocking need it raises: `ambiguous` when several fit, D90's `check_reference`
// when the one it names is only offered («Для <name>?»: one tap confirms it).
function bound(resolution: Exclude<Resolution, { kind: "none" }>, text: string, path: string): { readonly ref: Ref; readonly need: Need | null } {
  if (resolution.kind === "ask") {
    const candidates = resolution.candidates.map((candidate) => ({ id: candidate.entry.id, name: candidate.entry.name }));
    return { ref: { text, status: "ambiguous", candidates, focus: true }, need: { path, reason: "ambiguous", blocking: true } };
  }
  const { entry, index } = resolution.candidate;
  const ref: Ref = { text, status: "context", id: entry.id, ...(entry.name ? { name: entry.name } : {}), focus: index };
  return { ref, need: resolution.kind === "offer" ? { path, reason: "check_reference", blocking: true, span: { text } } : null };
}

// The refs the focus gives the command's reference words, by param, the needs they raise, and the params they claimed.
export function withFocus(bundle: Bundle, given: Decision, focus: readonly FocusEntry[]): Decision {
  // A refinement merges itself into the previous command (`refine.ts`).
  if (!isV3(bundle) || given.action === REFINE || !Object.hasOwn(bundle.intents, given.action)) return given;
  const held = heldOf(focus);
  const going = continued(bundle, given, held) ?? given;
  const typed = NO_RECORD_KINDS.has(intentOfAction(bundle, going.action).intent.kind) ? null : byFocusType(bundle, going, held, referencesOf(going));
  const decision = typed?.decision ?? going;
  const { intent } = intentOfAction(bundle, decision.action);
  if (NO_RECORD_KINDS.has(intent.kind)) return decision;
  const typeOf = (name: string): FocusType | null => {
    const declared: ParamType = intent.params[name] ?? "";
    return FOCUS_PARAM_TYPES.get(listItemType(bundle, declared) ?? declared) ?? null;
  };
  const listed = (name: string) => listItemType(bundle, intent.params[name] ?? "") !== undefined;
  const slots = Object.keys(intent.params).filter((name) => typeOf(name) !== null);
  const refs: Record<string, Param> = { ...(decision.fromPrevious ?? {}) };
  const needs: Need[] = [...(decision.focusNeeds ?? [])];
  const claimed = new Set<string>(decision.focusPaths ?? []);
  const open = (name: string) => !Object.hasOwn(decision.params, name) && !Object.hasOwn(decision.refPrevious, name) && !claimed.has(name);
  const fitting = (name: string, reference: Reference): Candidate[] => {
    const type = typeOf(name);
    const fits = held.records.filter((candidate) => candidate.entry.type === type && agrees(reference.form ?? null, candidate.entry) && restorable(candidate, decision.action));
    if (fits.length || type !== CUSTOMER) return fits;
    // An order's customer, when no customer is in focus («відправ йому посилання» after an order the host created for him): the order's place in the
    // conversation (D90: its turns, said, earlier, screen), its `customerName` as the name.
    const known = new Set<string>();
    return held.records.flatMap((candidate) => {
      const { customer, customerName, how, turns, said, earlier, screen } = candidate.entry;
      if (candidate.entry.type !== "order" || candidate.entry.closed === true || customer === undefined || known.has(customer)) return [];
      const newest = known.size === 0;
      known.add(customer);
      const entry: FocusEntry = { type: CUSTOMER, id: customer, name: customerName ?? "", how, ...(turns === undefined ? {} : { turns }), ...(said === undefined ? {} : { said }), ...(earlier === true ? { earlier } : {}), ...(screen === true ? { screen } : {}) };
      return [{ index: candidate.index, entry, newest }];
    });
  };
  // The params a reference may be said for, in the order it fills them.
  const targets = (reference: Reference): string[] => {
    switch (reference.kind) {
      case "this":
      case "new": {
        const typed = slots.filter((name) => typeOf(name) === reference.type);
        return typed.filter(open);
      }
      case "container":
        return FOCUS_CONTAINER_PARAMS.filter((name) => Object.hasOwn(intent.params, name) && open(name));
      case "dative": {
        const people = slots.filter((name) => typeOf(name) === CUSTOMER);
        return people.length ? people.filter(open) : slots.filter(open);
      }
      case "object": {
        // A pronoun said as the object is the record the action is on: the intent's first record param («підтверди його» the order, «видали її» after
        // a customer in `orders.cancel` asks).
        const [primary] = slots;
        return primary !== undefined && open(primary) ? [primary] : slots.filter(open);
      }
      case "prepositional":
        return slots.filter(open);
    }
  };
  // A dative pronoun or a place word said to a command that takes no record it could be (no customer and no other record param free for «йому»; no
  // group, order or price list for «туди»): the record in focus is not what the action is on, so the card asks instead of acting without it
  // («признач йому оптовий прайс» read as a price list's edit). «там» is often a filler («шо там у неї …») and never asks.
  const unplaced = (reference: Reference): boolean => {
    if (reference.kind === "dative") return !slots.some((name) => typeOf(name) === CUSTOMER);
    return reference.kind === "container" && reference.text !== LOOSE_PLACE && !FOCUS_CONTAINER_PARAMS.some((name) => Object.hasOwn(intent.params, name));
  };
  for (const reference of referencesOf(decision)) {
    if (typed !== null && reference.text === typed.reference.text) continue;
    const names = targets(reference);
    const [first] = names;
    if (first === undefined) {
      if (unplaced(reference) && !claimed.has(ACTION)) {
        claimed.add(ACTION);
        needs.push({ path: ACTION, reason: "reference", blocking: true, span: { text: reference.text } });
      }
      continue;
    }
    const target = names.find((name) => fitting(name, reference).length > 0);
    if (target === undefined) {
      if (reference.text === LOOSE_PLACE) continue;
      claimed.add(first);
      needs.push({ path: first, reason: "reference", blocking: true, span: { text: reference.text } });
      continue;
    }
    claimed.add(target);
    const resolution = resolve(fitting(target, reference), held.markers, reference);
    if (resolution.kind === "none") {
      needs.push({ path: target, reason: "reference", blocking: true, span: { text: reference.text } });
      continue;
    }
    const { ref, need } = bound(resolution, reference.text, listed(target) ? `${target}[0]` : target);
    refs[target] = listed(target) ? [ref] : ref;
    if (need !== null) needs.push(need);
  }
  if (!claimed.size) return decision;
  return { ...decision, fromPrevious: refs, focusNeeds: needs, focusPaths: [...claimed] };
}

const CREATES: Readonly<Record<string, Creates["type"]>> = {
  "customers.createCustomer": "customer",
  "customers.createGroup": "group",
  "customers.createCounterparty": "counterparty",
  "catalog.createProduct": "product",
  "pricing.createPriceList": "price_list",
  "orders.create": "order",
};

// A create command's `creates` (when the run passed a focus): the record's type and its name as the runtime reads it.
export function withCreates(command: CommandV2): CommandV2 {
  const type = Object.hasOwn(CREATES, command.action) ? CREATES[command.action] : undefined;
  if (type === undefined) return command;
  const said = command.params["new_name"];
  const text = type !== "order" && said !== undefined && !Array.isArray(said) && typeof said === "object" && "text" in said && typeof said.text === "string" ? said.text : null;
  const name = text === null ? null : type === CUSTOMER ? (nominativeName(text) ?? text) : text;
  const { debug, ...rest } = command;
  return { ...rest, creates: { type, name }, ...(debug === undefined ? {} : { debug }) };
}
