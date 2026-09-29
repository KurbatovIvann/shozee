import { intentOfAction, type ActionName, type Bundle, type Intent } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { RecordList } from "./context.ts";
import { GROUP_NOUNS, GROUP_PREPOSITIONS, PRICE_LIST_NOUNS, PRICE_LIST_PREPOSITIONS } from "./lexicon/lists.ts";
import { nameTokens, tokenMatch } from "./names.ts";
import { numberWordKind } from "./numbers.ts";
import type { ParamValue, Params } from "./params.ts";
import { listRef, type Lookup } from "./resolve.ts";
import type { Match, Ref } from "./result.ts";
import type { TaggedSpan } from "./spans.ts";

// D79 (sho-api-v2.md §8.11): groups, price lists and counterparties said in the words where the model's spans said less. The model tags a group, a
// price list or a counterparty by name when it is said as one; said in another case after a preposition («запрошення для салонів», «в групу
// установи», «з опту»), it often tags nothing, or tags it `new_name` («приглашение для геймеров»). The words are read against the context's list.

const GROUP = "group";
const COUNTERPARTY = "counterparty";
const PRICE_LIST = "price_list";
const NEW_NAME = "new_name";
// Span kinds that may hold the rest of a counterparty's name: the model tags a person's first name or a firm's name apart («фоп нечипорук | галина»
// customer, «тов | сота спейс» legal_name).
const NAME_KINDS: ReadonlySet<string> = new Set(["customer", "legal_name", "counterparty", "new_name", "pick_text"]);
// Words a counterparty's name grows by at most («петро іванович», «сота спейс»).
const MOST_GROWN = 4;
// A record the words name as a whole (its name or an alias, in any form), not by a part of it.
const WHOLE: ReadonlySet<Match> = new Set(["exact", "form", "alias"]);
// Words a record said in the words takes at most («постійні клієнти», «чорна п'ятниця», «літній розпродаж»).
const MOST_RUN = 3;
// The create command of a group and the update it becomes when the group is one the list has (`customers.createGroup` → `customers.updateGroup`).
const CREATE_GROUP = "customers.createGroup";
const UPDATE_GROUP = "customers.updateGroup";

export interface Listed {
  readonly action: ActionName;
  readonly params: Params;
}

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function wordsOf(utterance: string): Word[] {
  return Array.from(utterance.matchAll(/\S+/g), (match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function inSpan(word: Word, spans: readonly TaggedSpan[]): boolean {
  return spans.some((span) => span.start < word.end && span.end > word.start);
}

function paramOf(intent: Intent, type: string): string | undefined {
  return Object.entries(intent.params).find(([, found]) => found === type)?.[0];
}

class Lists {
  private readonly context: CompiledContext;
  private readonly lookup: Lookup;

  constructor(context: CompiledContext) {
    this.context = context;
    this.lookup = { records: context.records, customers: context.customers, restoring: false };
  }

  ref(list: RecordList, text: string): Ref {
    return listRef(text, this.context.records.lists[list], this.context.records.shop.partial.has(list), this.lookup);
  }

  // Whether a word said is a word of the record's name or of an alias («галина» of ФОП Нечипорук Галина; «мені», «з» of none).
  holds(list: RecordList, id: string, word: string): boolean {
    const record = this.context.records.lists[list]?.records.find((found) => found.id === id);
    if (record === undefined) return false;
    const own = [record.name, ...record.aliases].flatMap((text) => nameTokens(text));
    const said = nameTokens(word);
    return said.length > 0 && said.every((token) => own.some((known) => tokenMatch(token, known, { proper: true }) !== null));
  }

  // The one record the text names as a whole, else null.
  whole(list: RecordList, text: string): Ref | null {
    const found = this.ref(list, text);
    return found.status === "resolved" && found.match !== undefined && WHOLE.has(found.match) ? found : null;
  }
}

// A run of free words after a cue word (a preposition, a group noun) that names one record of the list as a whole: the longest run at each cue; none
// when the runs name two records. Free: in no model span, no number, no cue word.
// `closer`: a word said right after the run that cues it too («оптовий прайс»).
function namedAfterCue(words: readonly Word[], spans: readonly TaggedSpan[], cue: (word: string) => boolean, list: RecordList, lists: Lists, closer: (word: string) => boolean = () => false): string | null {
  const free = (word: Word | undefined) => word !== undefined && !inSpan(word, spans) && !cue(word.text) && !closer(word.text) && numberWordKind(word.text) === null && !/[0-9]/.test(word.text);
  const found = new Map<string, string>();
  const starts = [...words.keys()].flatMap((at) => [...(cue(words[at]?.text ?? "") ? [at + 1] : []), ...(closer(words[at]?.text ?? "") ? [...Array(MOST_RUN).keys()].map((back) => at - 1 - back) : [])]);
  for (const start of new Set(starts)) {
    if (start < 0) continue;
    for (let length = MOST_RUN; length >= 1; length--) {
      const run = words.slice(start, start + length);
      const next = words[start + length];
      if (!cue(words[start - 1]?.text ?? "") && (next === undefined || !closer(next.text))) continue;
      if (run.length < length || !run.every(free)) continue;
      const text = run.map((one) => one.text).join(" ");
      const ref = lists.whole(list, text);
      if (ref === null || typeof ref.id !== "string") continue;
      if (!found.has(ref.id)) found.set(ref.id, text);
      break;
    }
  }
  const [only] = found.values();
  return found.size === 1 && only !== undefined ? only : null;
}

function groupCue(word: string): boolean {
  return GROUP_NOUNS.has(word) || GROUP_PREPOSITIONS.has(word);
}

// The word right before a span's text: a cue says the words after it name a group («для геймеров»).
function cuedSpan(utterance: string, text: string, cue: (word: string) => boolean): boolean {
  const at = ` ${utterance} `.indexOf(` ${text} `);
  const before = at < 0 ? undefined : utterance.slice(0, at).split(/\s+/).filter(Boolean).at(-1);
  return before !== undefined && cue(before);
}

// Groups (D79 item 1): a command that takes a group and has none gets the group its words name: a `new_name` span said after a cue that names a group
// (`invites.create` «для геймеров»; never the group's own create), else a run of free words after a group noun or «для / в / у / до» («переведи … в
// групу установи», «запрошення для салонів»). A group create that names no new group, only a group the list has and what to change in it («признач
// групі салони партнерський прайс»), is that group's update.
function withGroup(bundle: Pick<Bundle, "intents">, listed: Listed, spans: readonly TaggedSpan[], utterance: string, lists: Lists): Listed {
  const { intent } = intentOfAction(bundle, listed.action);
  const params: Record<string, ParamValue> = { ...listed.params };
  const name = paramOf(intent, GROUP);
  if (listed.action === CREATE_GROUP && params[NEW_NAME] === undefined && Object.hasOwn(bundle.intents, UPDATE_GROUP)) {
    const update = intentOfAction(bundle, UPDATE_GROUP);
    const target = paramOf(update.intent, GROUP);
    const said = spans.filter((span) => span.kind === GROUP && lists.whole("groups", span.text) !== null);
    const [group] = said;
    const kept = Object.entries(params).filter(([param]) => Object.hasOwn(update.intent.params, param));
    if (target !== undefined && said.length === 1 && group !== undefined && kept.length > 0 && kept.length === Object.keys(params).length) {
      return { action: update.action, params: { [target]: group.text, ...Object.fromEntries(kept) } };
    }
  }
  if (name === undefined || params[name] !== undefined) return listed;
  const newName = params[NEW_NAME];
  if (listed.action !== CREATE_GROUP && typeof newName === "string" && lists.whole("groups", newName) !== null && cuedSpan(utterance, newName, groupCue)) {
    delete params[NEW_NAME];
    params[name] = newName;
    return { action: listed.action, params };
  }
  const named = namedAfterCue(wordsOf(utterance), spans, groupCue, "groups", lists);
  if (named === null) return listed;
  params[name] = named;
  return { action: listed.action, params };
}

// The words of a text in the utterance: the index of its first word, where it is said word for word; -1 when it is not.
function placeOf(words: readonly Word[], text: string): number {
  const said = text.split(/\s+/).filter(Boolean);
  return said.length ? words.findIndex((_, start) => said.every((word, offset) => words[start + offset]?.text === word)) : -1;
}

// Counterparties (D79 item 2): a counterparty said in part («фоп нечипорук», «фоп коваленко» of two Коваленко, «тов» alone) takes the words said right
// after it that complete one record's name («… галина», «… петро іванович», «… сота спейс»): the longest run that names one counterparty (the one the
// part named, when it named one) through a name the model tagged apart, never through another param's words or a number. A param said inside the
// words it took (the customer «галина», the legal name «сота спейс») goes.
function withCounterparty(bundle: Pick<Bundle, "intents">, listed: Listed, spans: readonly TaggedSpan[], utterance: string, lists: Lists): Listed {
  const { intent } = intentOfAction(bundle, listed.action);
  const name = paramOf(intent, COUNTERPARTY);
  const said = name === undefined ? undefined : listed.params[name];
  if (name === undefined || typeof said !== "string") return listed;
  const before = lists.ref("counterparties", said);
  if (before.status === "resolved" && before.match !== "part") return listed;
  const words = wordsOf(utterance);
  const at = placeOf(words, said);
  if (at < 0) return listed;
  const end = at + said.split(/\s+/).filter(Boolean).length;
  const free = (word: Word) => numberWordKind(word.text) === null && !/[0-9]/.test(word.text) && spans.every((span) => !(span.start < word.end && span.end > word.start) || NAME_KINDS.has(span.kind));
  let reach = 0;
  while (reach < MOST_GROWN && words[end + reach] !== undefined && free(words[end + reach] as Word)) reach++;
  for (let length = reach; length >= 1; length--) {
    const grown = words.slice(at, end + length).map((word) => word.text).join(" ");
    const found = lists.ref("counterparties", grown);
    const taken = words.slice(end, end + length);
    // A part grows to the whole name of the record it named; an ambiguous or unknown name to one record; every word taken is one of its name's.
    const better = before.status === "resolved" ? found.id === before.id && found.match !== undefined && WHOLE.has(found.match) : true;
    if (found.status !== "resolved" || typeof found.id !== "string" || !better || !taken.every((word) => lists.holds("counterparties", found.id as string, word.text))) continue;
    const inside = (text: string) => {
      const place = placeOf(taken, text);
      return place >= 0;
    };
    const params = Object.fromEntries(Object.entries(listed.params).filter(([param, value]) => param === name || typeof value !== "string" || !inside(value)));
    return { action: listed.action, params: { ...params, [name]: grown } };
  }
  return listed;
}

const LIST_OF: Readonly<Record<string, RecordList>> = { group: "groups", price_list: "priceLists", counterparty: "counterparties" };

// D79: the segmenter cut an utterance inside a record's name («видали контрагента фоп коваленко | петро іванович»: a delete and a picker): when the
// whole utterance's reading names one group, price list or counterparty whose words run over a cut, the utterance is that one command.
export function nameAcross(bundle: Pick<Bundle, "intents">, action: string, params: Params, text: string, segments: readonly string[], context: CompiledContext | null): boolean {
  if (context === null || context.empty || segments.length < 2) return false;
  const starts: number[] = [];
  let from = 0;
  for (const segment of segments) {
    const at = text.indexOf(segment, from);
    if (at < 0) return false;
    starts.push(at);
    from = at + segment.length;
  }
  const lists = new Lists(context);
  const { intent } = intentOfAction(bundle, action);
  return Object.entries(intent.params).some(([name, type]) => {
    const list = Object.hasOwn(LIST_OF, type) ? LIST_OF[type] : undefined;
    const value = params[name];
    if (list === undefined || typeof value !== "string") return false;
    const at = ` ${text} `.indexOf(` ${value} `);
    return at >= 0 && lists.ref(list, value).status === "resolved" && starts.slice(1).some((start) => start > at && start < at + value.length);
  });
}

function priceListCue(word: string): boolean {
  return PRICE_LIST_PREPOSITIONS.has(word) || PRICE_LIST_NOUNS.has(word);
}

// Price lists (D79 item 3): a command that takes a price list and has none gets the one its words name after a preposition or «прайс», or right
// before «прайс» («поло … з опту прибери» Опт, «в оптовий прайс», «у партнерському прайсі»), in any case and by its aliases.
function withPriceList(bundle: Pick<Bundle, "intents">, listed: Listed, spans: readonly TaggedSpan[], utterance: string, lists: Lists): Listed {
  const { intent } = intentOfAction(bundle, listed.action);
  const name = paramOf(intent, PRICE_LIST);
  if (name === undefined || listed.params[name] !== undefined) return listed;
  const named = namedAfterCue(wordsOf(utterance), spans, priceListCue, "priceLists", lists, (word) => PRICE_LIST_NOUNS.has(word));
  return named === null ? listed : { action: listed.action, params: { ...listed.params, [name]: named } };
}

export function namedLists(bundle: Pick<Bundle, "intents">, action: ActionName, params: Params, spans: readonly TaggedSpan[], utterance: string, context: CompiledContext): Listed {
  if (context.empty) return { action, params };
  const lists = new Lists(context);
  const grouped = withGroup(bundle, { action, params }, spans, utterance, lists);
  return withPriceList(bundle, withCounterparty(bundle, grouped, spans, utterance, lists), spans, utterance, lists);
}
