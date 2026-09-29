import { intentOfAction, isV3, listItemType, type Bundle, type ParamType } from "./bundle.ts";
import { deictics, type Decision } from "./command.ts";
import { nameGender } from "./gender.ts";
import { PRONOUN_FORMS, type PronounForm } from "./lexicon/references.ts";
import { REFINE, ageOf, type Previous, type RefineClock } from "./refine.ts";
import type { Param, Ref, SpanParam } from "./result.ts";

// D79 (sho-api-v2.md §8.11): a pronoun said for a record («архівуй її», «поверни його з архіву», «видали його», «додай їй коментар») is the record of
// that kind in the command the host ran before, when the host passes it (`RunOptions.previous`, D78) and it is within the refinement window. The
// param a pronoun fills is one the command takes and has no value for, of a record's type (a customer, a product, an order, a document, a group, a
// price list, a counterparty), and the previous command holds one such record; a pronoun agrees where it is cheap to tell: «її» / «їй» never fills a
// man's name nor an order («замовлення»), «його» / «йому» never a woman's name, «їх» / «їм» only a list of customers. The ref keeps `status:
// "context"` (a word that points at a record, D70) and gets the record's `id` and `name`. With no previous command, an old one, or no record of the
// kind in it, the command is what it was.

const TYPES: ReadonlySet<string> = new Set(["customer", "product", "order_number", "document_ref", "group", "price_list", "counterparty"]);
const CUSTOMER = "customer";
const ORDER = "order_number";

// D82: the gender rules moved to `gender.ts` (the nominative of a suggested name reads them too).
export { nameGender };

interface Found {
  readonly type: string;
  readonly id: string;
  readonly name: string;
  // A list of several (customers of a group move): only a plural pronoun takes it.
  readonly many: readonly Ref[] | null;
}

function isRef(param: Param | undefined): param is Ref {
  return param !== undefined && !Array.isArray(param) && typeof param === "object" && "status" in param && "text" in param && !("attrs" in param);
}

function isSpan(param: Param | undefined): param is SpanParam {
  return param !== undefined && !Array.isArray(param) && typeof param === "object" && "text" in param && !("status" in param) && !("attrs" in param);
}

// A record a ref names: resolved, or filled from an earlier previous command (a context ref with an id).
function named(ref: Ref): boolean {
  return (ref.status === "resolved" || ref.status === "context") && typeof ref.id === "string" && ref.name !== undefined;
}

// The records the previous command holds, by type: its refs of a record type, a list of customers, and an order or a document said by its number.
function recordsOf(bundle: Bundle, previous: Previous): Found[] {
  const command = previous.command;
  const types = Object.hasOwn(bundle.intents, command.action) ? intentOfAction(bundle, command.action).intent.params : {};
  return Object.entries(command.params).flatMap(([name, param]): Found[] => {
    const declared: ParamType = Object.hasOwn(types, name) ? (types[name] ?? name) : name;
    const type = listItemType(bundle, declared) ?? declared;
    if (!TYPES.has(type)) return [];
    if (Array.isArray(param)) {
      const refs = (param as readonly unknown[]).filter((item): item is Ref => isRef(item as Param) && named(item as Ref));
      const [only] = refs;
      if (refs.length === 1 && only !== undefined) return [{ type, id: only.id as string, name: only.name as string, many: null }];
      return refs.length > 1 ? [{ type, id: "", name: "", many: refs }] : [];
    }
    if (isRef(param) && named(param)) return [{ type, id: param.id as string, name: param.name as string, many: null }];
    if (isSpan(param) && (type === ORDER || type === "document_ref")) {
      const value = param.value;
      return [{ type, id: typeof value === "string" || typeof value === "number" ? String(value) : param.text, name: param.text, many: null }];
    }
    return [];
  });
}

// Whether a pronoun agrees with a record: «її» no man and no order, «його» no woman, «їх» only a list.
function agrees(form: PronounForm, found: Found): boolean {
  if (form.number === "plural") return found.many !== null;
  if (found.many !== null) return false;
  if (form.gender === "feminine" && found.type === ORDER) return false;
  if (found.type !== CUSTOMER || form.gender === null) return true;
  const gender = nameGender(found.name);
  return gender === null || gender === form.gender;
}

function refOf(text: string, found: Found): Ref {
  return { text, status: "context", id: found.id, name: found.name };
}

// The pronouns of the command's words that no model span holds, in the order said.
function pronounsSaid(decision: Decision): (readonly [word: string, form: PronounForm])[] {
  return decision.text.toLowerCase().split(/\s+/).flatMap((word): (readonly [string, PronounForm])[] => {
    const form = PRONOUN_FORMS.get(word);
    if (form === undefined || decision.spans.some((span) => span.text.toLowerCase().split(/\s+/).includes(word))) return [];
    return [[word, form]];
  });
}

// The refs the previous command fills, by param: the params a deictic word points at (D70 `context`, now with the record) and the params a bare pronoun
// is said for.
export function fromPrevious(bundle: Bundle, decision: Decision, previous: Previous | null, clock: RefineClock, window: number): Readonly<Record<string, Param>> {
  // A refinement merges into the previous command itself (`refine.ts`).
  if (previous === null || !isV3(bundle) || decision.action === REFINE || !(ageOf(previous.at, clock) <= window)) return {};
  const records = recordsOf(bundle, previous);
  if (!records.length) return {};
  const types = intentOfAction(bundle, decision.action).intent.params;
  const typeOf = (name: string) => {
    const declared = types[name] ?? "";
    return listItemType(bundle, declared) ?? declared;
  };
  const open = (name: string) => !Object.hasOwn(decision.params, name) && !Object.hasOwn(decision.refPrevious, name) && TYPES.has(typeOf(name));
  const listed = (name: string) => listItemType(bundle, types[name] ?? "") !== undefined;
  // A record of the param's type the pronoun agrees with: one record for a param of one, a list for a list («переведи їх у групу …»).
  const fitting = (name: string, form: PronounForm | null, found: Found) => found.type === typeOf(name) && (form === null || agrees(form, found)) && (found.many === null || listed(name));
  const filled: Record<string, Param> = {};
  const one = (name: string, form: PronounForm | null, text: string) => {
    const fits = records.filter((found) => fitting(name, form, found));
    const [only] = fits;
    if (fits.length !== 1 || only === undefined) return;
    if (only.many !== null) filled[name] = only.many.map((ref) => ({ text, status: "context" as const, id: ref.id ?? null, name: ref.name ?? ref.text }));
    else filled[name] = listed(name) ? [refOf(text, only)] : refOf(text, only);
  };
  for (const [name, phrase] of deictics(bundle, decision)) if (open(name)) one(name, PRONOUN_FORMS.get(phrase) ?? null, phrase);
  for (const [word, form] of pronounsSaid(decision)) {
    const candidates = Object.keys(types).filter((name) => open(name) && !Object.hasOwn(filled, name) && (!form.dative || typeOf(name) === CUSTOMER));
    // An object pronoun («його», «її») is the thing acted on before the person: a customer only when nothing else fits.
    const ordered = form.dative ? candidates : [...candidates.filter((name) => typeOf(name) !== CUSTOMER), ...candidates.filter((name) => typeOf(name) === CUSTOMER)];
    const target = ordered.find((name) => records.some((found) => fitting(name, form, found)));
    if (target !== undefined) one(target, form, word);
  }
  return filled;
}
