import type { Intent, ParamType } from "./bundle.ts";
import { ITEMS_PARAM, quantityAt, type CompiledContext } from "./catalogue.ts";
import { CUSTOMER_LEADS, LEGAL_FORMS } from "./lexicon/customers.ts";
import type { OrderLine } from "./lines.ts";
import { isNames, type ParamValue, type Params } from "./params.ts";
import type { TaggedSpan } from "./spans.ts";
import { isLegal, nameMatch, nameWords, placeNoun, type NameList } from "./nameList.ts";

export interface CustomerMatch {
  readonly text: string;
  readonly name: string | null;
}

// A customer param resolves to the known name; a customer list (D58) to one entry per spoken name, in the same order, null where no known name matches.
export type ResolvedName = string | readonly (string | null)[];
export type Resolved = Readonly<Record<string, ResolvedName>>;

export interface CustomerResolution {
  readonly params: Record<string, ParamValue>;
  readonly resolved: Resolved;
  readonly startHint: number | null;
}

export interface ListResolution {
  readonly names: readonly string[];
  readonly resolved: readonly (string | null)[];
}

const CUSTOMER_TYPE = "customer";
// How many words before a customer span may complete a known name.
const COMPLETED_WORDS = 2;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// «Катю» for «Катя Самбука» (D61): a bare first name is the two-word customer it starts when no other customer's name starts with it; the name matched is
// the first word only.
function byFirstName(spoken: string, customers: NameList): readonly [name: string, known: readonly string[]] | null {
  const starting = customers.startingWith(spoken).filter(([, words]) => nameMatch(spoken, words[0] ?? ""));
  const [only] = starting;
  return starting.length === 1 && only !== undefined && only[1].length === 2 ? [only[0], only[1].slice(0, 1)] : null;
}

// The known customer whose name the words start with, the longest one, or a bare first name (`byFirstName`): the name and its words as known.
export function knownNameAt(following: readonly string[], customers: NameList): readonly [name: string, known: readonly string[]] | null {
  let best: readonly [name: string, known: readonly string[]] | null = null;
  for (const [name, known] of customers.startingWith(following[0] ?? "")) {
    if (!known.length || known.length > following.length) continue;
    if (known.every((word, index) => nameMatch(following[index] ?? "", word)) && (best === null || known.length > best[1].length)) best = [name, known];
  }
  return best ?? byFirstName(following[0] ?? "", customers);
}

// The most words a place's name may take after the words that say what kind of place it is.
const PLACE_NAME_WORDS = 3;

// D73: «оформи заказ на садик горобинка»: a customer span that only says what kind of place or firm a customer is («садик», «кафе», «салон», «ФОП»,
// «ТОВ») names the customer the words after it complete, the longest run of up to three words (no quantity among them) that names one customer in
// order or in part (`NameList.spokenNames`: «садик горобинка» for «Дитячий садок «Горобинка»»). Else nothing changes.
function placeNamed(words: readonly string[], following: readonly string[], customers: NameList): CustomerMatch | null {
  if (!words.length || !words.every((word) => placeNoun(word) || isLegal(word))) return null;
  let found: CustomerMatch | null = null;
  for (let more = 1; more <= PLACE_NAME_WORDS && words.length + more <= following.length; more++) {
    if (quantityAt([following[words.length + more - 1] ?? ""], 0) !== null) break;
    const said = following.slice(0, words.length + more);
    const inOrder = knownNameAt(said, customers);
    const named = inOrder !== null && inOrder[1].length === said.length ? [inOrder[0]] : customers.spokenNames(said);
    const [only] = named;
    if (named.length === 1 && only !== undefined) found = { text: said.join(" "), name: only };
  }
  return found;
}

function keepsFinalSpan(following: readonly string[], spanLength: number, nameLength: number, catalogue: CompiledContext | null, breaks: ReadonlySet<string>): boolean {
  if (nameLength >= spanLength || following.length > spanLength) return false;
  const last = following[nameLength - 1] ?? "";
  const next = following[nameLength] ?? "";
  const itemLike = catalogue !== null && (catalogue.match([next]) !== null || quantityAt([next], 0) !== null);
  return !itemLike && !breaks.has(`${last} ${next}`);
}

export function resolveCustomer(
  utterance: string,
  span: string,
  customers: NameList,
  catalogue: CompiledContext | null = null,
  trim = false,
  breaks: ReadonlySet<string> = new Set(),
): CustomerMatch | null {
  const start = utterance.indexOf(span);
  if (start < 0) return null;
  const following = wordsOf(utterance.slice(start));
  const best = knownNameAt(following, customers);
  let words = wordsOf(span);
  const place = placeNamed(words, following, customers);
  if (place !== null) return place;
  // A name said in another order or in part (D71): the whole span names one customer, where the names in order name fewer of its words.
  const spoken = best === null || best[1].length < words.length ? customers.spokenNames(words) : [];
  if (spoken.length === 1 && spoken[0] !== undefined) return { text: words.join(" "), name: spoken[0] };
  if (best && surnameSaid(best[0], words.slice(best[1].length), following.slice(words.length), catalogue)) return { text: words.join(" "), name: best[0] };
  if (best && otherSurname(best, words)) return null;
  if (best && !keepsFinalSpan(following, words.length, best[1].length, catalogue, breaks)) return { text: following.slice(0, best[1].length).join(" "), name: best[0] };
  const original = words.length;
  if (trim) {
    const cut = words.findIndex((word, index) => index + 1 < words.length && breaks.has(`${word} ${words[index + 1] ?? ""}`));
    if (cut >= 0) words = words.slice(0, cut + 1);
  }
  let after = following.slice(words.length, words.length + 1);
  while (trim && catalogue !== null && words.length > 1) {
    const last = words.at(-1) ?? "";
    const next = after[0];
    if (catalogue.match([last])) after = [last];
    else if (quantityAt([last], 0) && !(next !== undefined && quantityAt([next], 0))) after = [last];
    else break;
    words.pop();
  }
  return words.length !== original ? { text: words.join(" "), name: null } : null;
}

// Every name of a customer list resolves like a lone customer span (D56 stems and case forms); a name the one before it grew over («катю» + «самбуку» →
// «катю самбуку») is that name, not a second customer.
export function resolveCustomerList(utterance: string, spans: readonly string[], customers: NameList, breaks: ReadonlySet<string> = new Set()): ListResolution {
  const names: string[] = [];
  const resolved: (string | null)[] = [];
  let covered = 0;
  for (const span of spans) {
    const start = utterance.indexOf(span);
    if (start >= 0 && start < covered) continue;
    const found = resolveCustomer(utterance, span, customers, null, false, breaks);
    const text = found?.text ?? span;
    if (names.includes(text)) continue;
    names.push(text);
    resolved.push(found?.name ?? null);
    if (start >= 0) covered = start + text.length;
  }
  return { names, resolved };
}

function customerList(listTypes: Readonly<Record<ParamType, string>>, type: ParamType): boolean {
  return Object.hasOwn(listTypes, type) && listTypes[type] === CUSTOMER_TYPE;
}

export function resolveCustomers(
  intent: Intent,
  utterance: string,
  params: Params,
  context: CompiledContext,
  breaks: ReadonlySet<string>,
  listTypes: Readonly<Record<ParamType, string>> = {},
): CustomerResolution {
  const resolvedParams: Record<string, ParamValue> = { ...params };
  const resolved: Record<string, ResolvedName> = {};
  let startHint: number | null = null;
  for (const [name, type] of Object.entries(intent.params)) {
    const span = resolvedParams[name];
    if (customerList(listTypes, type) && isNames(span)) {
      const list = resolveCustomerList(utterance, span, context.customers, breaks);
      resolvedParams[name] = list.names;
      if (list.resolved.some((known) => known !== null)) resolved[name] = list.resolved;
      continue;
    }
    if (type !== CUSTOMER_TYPE || typeof span !== "string") continue;
    const found = resolveCustomer(utterance, span, context.customers, context, Array.isArray(resolvedParams[ITEMS_PARAM]), breaks);
    if (!found) continue;
    const original = utterance.indexOf(span);
    if (original >= 0 && found.text.length < span.length && span.startsWith(found.text)) startHint = original + found.text.length + 1;
    resolvedParams[name] = found.text;
    if (found.name) resolved[name] = found.name;
  }
  return { params: resolvedParams, resolved, startHint };
}

function wordIndex(words: readonly string[], span: string): number {
  const said = wordsOf(span);
  return words.findIndex((_, start) => said.length > 0 && said.every((word, offset) => words[start + offset] === word));
}

// «маска для волосся», «крем для лица»: a span led by «для» that the words before make a catalogue product with is part of that product, not a customer.
function insideProductName(utterance: string, span: string, catalogue: CompiledContext): boolean {
  const words = wordsOf(utterance);
  const at = wordIndex(words, span);
  if (at < 2 || !CUSTOMER_LEADS.has(words[at - 1] ?? "")) return false;
  const end = at + wordsOf(span).length;
  for (let from = at - 2; from >= Math.max(0, at - 1 - catalogue.longest); from--) if (catalogue.find(words.slice(from, end))?.kind === "product") return true;
  return false;
}

// The customer a command takes (D64): the span the model chose when the customer list knows it (or there is no list); else the first other customer span
// the list knows («білі» → «шерлок», «для волосся» → «коваленко»); else the span grown back to a known name («самбуці» → «каті самбуці»); else the chosen
// span, unless «для» inside a catalogue name led it («маска для волосся»), which is no customer at all (null).
export function chosenCustomer(spans: readonly TaggedSpan[], current: string, utterance: string, context: CompiledContext): string | null {
  const inOrder = (text: string): boolean => knownNameAt(wordsOf(text), context.customers) !== null;
  // D71: a name said in another order or in part («самбуці», «вікторії гордійчук») is known too; the words before it that make the whole name stay.
  const knows = (text: string): boolean => inOrder(text) || context.customers.spokenNames(wordsOf(text)).length === 1;
  if (!context.customers.length || inOrder(current)) return current;
  if (knows(current)) return completedName(utterance, current, context.customers) ?? current;
  const other = spans.find((span) => span.kind === CUSTOMER_TYPE && span.text !== current && knows(span.text));
  if (other !== undefined) return other.text;
  return completedName(utterance, current, context.customers) ?? (insideProductName(utterance, current, context) ? null : current);
}

// «каті самбуці» when the model tagged only «самбуці»: the words before the span that make it a known customer's whole name.
function completedName(utterance: string, span: string, customers: NameList): string | null {
  const words = wordsOf(utterance);
  const at = wordIndex(words, span);
  const end = at + wordsOf(span).length;
  for (let from = at - 1; from >= Math.max(0, at - COMPLETED_WORDS); from--) {
    const said = words.slice(from, end);
    if (knownNameAt(said, customers)?.[1].length === said.length) return said.join(" ");
  }
  return null;
}

export interface CustomerFirst {
  readonly lines: readonly OrderLine[];
  readonly customer: string;
  readonly name: string;
}

// «Наді торт малиновий …», «Мельник тонік 3 …» (D64): an order whose first line's product starts with a known customer's name, and is no catalogue product,
// said its customer first. A line that is only the name (no quantity, no flavour, another line after it) goes; else the name leaves its product. The order
// takes the customer when it has none; one that has another customer keeps its lines.
export function customerFirst(lines: readonly OrderLine[], customer: string | undefined, context: CompiledContext): CustomerFirst | null {
  const [first, ...rest] = lines;
  if (first === undefined || !context.customers.length) return null;
  const words = wordsOf(first.product);
  const found = knownNameAt(words, context.customers);
  if (found === null || context.find(words) !== null) return null;
  const said = customer === undefined ? null : knownNameAt(wordsOf(customer), context.customers);
  if (customer !== undefined && said?.[0] !== found[0]) return null;
  const name = words.slice(0, found[1].length).join(" ");
  const product = words.slice(found[1].length).join(" ");
  const bare = !product && first.quantity === undefined && !first.attrs.length && rest.length > 0;
  if (!product && !bare) return null;
  return { lines: bare ? rest : [{ ...first, product }, ...rest], customer: customer ?? name, name: found[0] };
}

// «Шевченко крем для обличчя …» with nothing tagged for Шевченко (D64): an order with no customer whose utterance starts with a known customer's name, which
// is no catalogue product and no order line reads, is that customer's. The words and the known name.
export function leadingCustomer(utterance: string, lines: readonly OrderLine[], context: CompiledContext): readonly [text: string, name: string] | null {
  const words = wordsOf(utterance);
  const found = knownNameAt(words, context.customers);
  if (found === null) return null;
  const said = words.slice(0, found[1].length);
  const read = lines.some((line) => wordsOf(line.product).some((word) => said.includes(word)));
  return context.find(said) === null && !read ? [said.join(" "), found[0]] : null;
}

// D73: a product line whose first words the customer's name holds («тарасу гречку малиновий бісквітний торт»: the name grew over «гречку», which the
// model also tagged a product; «катю лагоду самсунг с25»): those words are the customer's. A line left with no product goes when it says nothing else;
// else it keeps its words.
export function outsideCustomer(lines: readonly OrderLine[], customer: string, utterance: string): OrderLine[] {
  const words = wordsOf(utterance);
  const start = wordIndex(words, customer);
  if (start < 0) return [...lines];
  const end = start + wordsOf(customer).length;
  return lines.flatMap((line) => {
    const said = wordsOf(line.product);
    const says = (from: number) => said.length > 0 && said.every((word, offset) => words[from + offset] === word);
    const at = words.findIndex((_, from) => from >= start && from < end && says(from));
    // A product said again after the name is that line's («марині кеди converse … і кеди converse білі»).
    if (at < 0 || words.some((_, from) => from >= end && says(from))) return [line];
    const rest = said.slice(end - at);
    if (rest.length) return [{ ...line, product: rest.join(" ") }];
    return line.quantity === undefined && !line.attrs.length ? [] : [line];
  });
}

// Word endings of Ukrainian and Russian surnames in the cases a customer is said in («петренко», «ковальчуку», «мельникова», «сидоровій», «бондарівському»):
// a word right after a known customer whose record has no surname is the surname said with the name, not a product (`surnameAfter`).
const SURNAME = /(?:енк[оау]|енкові|[чщю]ук(?:|а|у|ові|ом)|[оеє]вич(?:|а|у|еві|ем)|[сцз]ьк(?:ий|ого|ому|а|ій|ої|у|ою)|[сцз]к(?:ий|ого|ому|ая|ой|ую)|[оеє]в(?:а|у|ої|ій|ою|ой|ым)?|[іїы]н(?:а|у|ій|ої|ові|ой|ым)|ишин(?:а|у)?)$/u;

export function surnameLike(word: string): boolean {
  return Array.from(word).length >= 5 && SURNAME.test(word);
}

// A known name with no surname (one word besides a legal form: «Олена»).
function withoutSurname(known: string): boolean {
  return nameWords(known).filter((word) => !LEGAL_FORMS.has(word)).length === 1;
}

// D73: the one word the model's customer span says after a known name that has no surname («олені петренко» for «Олена»), surname-like and no catalogue
// word or quantity, stays the customer's; not when a count with its unit follows it, which counts it as a product («шерлока павлова 8 штук», lh-310).
function surnameSaid(known: string, extra: readonly string[], after: readonly string[], catalogue: CompiledContext | null): boolean {
  const [word] = extra;
  const counted = quantityAt(after, 0);
  if (counted !== null && counted[0] > 1) return false;
  return extra.length === 1 && word !== undefined && withoutSurname(known) && surnameLike(word) && (catalogue === null || catalogue.match([word]) === null) && quantityAt([word], 0) === null;
}

// D82: «акт сверки с олегом петренко» where the list knows Олег Тищенко: the span's word after the first name the known name was matched by is surname-like
// and is not that customer's surname, so the span names someone else; the bare first name (`byFirstName`) does not take it. The span stays as said and
// resolves as an unknown customer, with the known one `nearest`.
function otherSurname(best: readonly [name: string, known: readonly string[]], words: readonly string[]): boolean {
  const matched = best[1].length;
  const next = words[matched];
  const surname = nameWords(best[0])[matched];
  return next !== undefined && surname !== undefined && surnameLike(next) && !nameMatch(next, surname);
}

// D73: «олені петренко два торти» where the customer list knows «Олена» with no surname: a surname-like word right after the name (`surnameLike`), which the
// catalogue does not know, and which starts the first line's product, is the customer's, when what is left of the product names a catalogue product or the
// line says nothing else and more lines follow. The customer's words with it, or null.
export function surnameAfter(lines: readonly OrderLine[], customer: string, known: string, utterance: string, context: CompiledContext): string | null {
  const [first, ...rest] = lines;
  if (first === undefined || !withoutSurname(known)) return null;
  const words = wordsOf(utterance);
  const start = wordIndex(words, customer);
  const next = start < 0 ? undefined : words[start + wordsOf(customer).length];
  const product = wordsOf(first.product);
  if (next === undefined || product[0] !== next || !surnameLike(next) || context.match([next]) !== null || quantityAt([next], 0) !== null) return null;
  // A product the catalogue knows with the word («детский велосипед формула», «заміна лобового скла») keeps it.
  const hits = context.records.products(first.product);
  if (context.find(product) !== null || hits.whole.length + hits.part.length + hits.named.length > 0) return null;
  const left = product.slice(1);
  const named = left.length > 0 && context.find(left)?.kind === "product";
  const bare = !left.length && first.quantity === undefined && !first.attrs.length && rest.length > 0;
  return named || bare ? `${customer} ${next}` : null;
}

// D73: the model's item spans without the words the customer's name holds, so the catalogue pass reads the items from after the name.
export function spansOutsideCustomer(spans: readonly TaggedSpan[], customer: string, utterance: string, kinds: ReadonlySet<string>): TaggedSpan[] {
  const start = ` ${utterance} `.indexOf(` ${customer} `);
  if (start < 0 || !customer) return [...spans];
  const end = start + customer.length;
  return spans.flatMap((span) => {
    if (!kinds.has(span.kind) || span.start < start || span.start >= end) return [span];
    const rest = utterance.slice(end, span.end);
    const skip = rest.length - rest.trimStart().length;
    return span.end <= end || !rest.trim() ? [] : [{ ...span, start: end + skip, text: rest.trim() }];
  });
}
