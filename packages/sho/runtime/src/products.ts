import { intentOfAction, type ActionName, type Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import { knownNameAt } from "./customers.ts";
import { nameWords } from "./nameList.ts";
import { LABEL_WORDS, LIST_WORDS } from "./lexicon/catalogue.ts";
import { UNITS } from "./lexicon/units.ts";
import { CUSTOMER_WORD_STEMS } from "./lexicon/customers.ts";
import { isNames, type ParamValue, type Params } from "./params.ts";

// Product readings of what the model gave a customer slot or a narrower product span, against the catalogue (D64).

// An action on one customer and the same action on a product: the model reads an unknown name after «покажи», «архівуй» as a customer.
const COUNTERPARTS: ReadonlyMap<string, string> = new Map([
  ["customers.getCustomer", "catalog.getProduct"],
  ["customers.archiveCustomer", "catalog.archiveProduct"],
  ["customers.restoreCustomer", "catalog.restoreProduct"],
  ["customers.listCustomers", "catalog.listProducts"],
]);
const GET_PRODUCT = "catalog.getProduct";
const LIST_PRODUCTS = "catalog.listProducts";
const PRODUCT = "product";
const CUSTOMER = "customer";
const SEARCH = "search_text";
const ATTRS = "attrs";

export interface ProductReading {
  readonly action: ActionName;
  readonly params: Params;
}

type Window = readonly [whole: number, length: number, start: number, end: number];

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function wordIndex(words: readonly string[], span: string): number {
  const said = wordsOf(span);
  return words.findIndex((_, start) => said.length > 0 && said.every((word, offset) => words[start + offset] === word));
}

// «картка клієнта вареничка»: the utterance names the customer record.
function customerSaid(utterance: string): boolean {
  return wordsOf(utterance).some((word) => CUSTOMER_WORD_STEMS.some((stem) => word.startsWith(stem)));
}

// «всі сукні»: a list word right before the span.
function listAsked(utterance: string, span: string): boolean {
  const words = wordsOf(utterance);
  const at = wordIndex(words, span);
  return at > 0 && LIST_WORDS.has(words[at - 1] ?? "");
}

function known(bundle: Pick<Bundle, "intents">, action: string): action is ActionName {
  return Object.hasOwn(bundle.intents, action);
}

function kept(bundle: Pick<Bundle, "intents">, action: ActionName, params: Record<string, ParamValue>): Params {
  const types = intentOfAction(bundle, action).intent.params;
  return Object.fromEntries(Object.entries(params).filter(([name]) => Object.hasOwn(types, name)));
}

// «архівуй Nike Terra», «покажи всі сукні»: a customer action whose name is no known customer (none starts it) but speaks of catalogue products is the same
// action on the product; a get of several products, or of «всі …», lists them. Never when the customer list knows the name, nor when the utterance names
// the customer record («клієнта», «покупців»).
function counterpart(bundle: Pick<Bundle, "intents">, action: ActionName, params: Params, utterance: string, context: CompiledContext): ProductReading | null {
  const target = COUNTERPARTS.get(action);
  const slot = action === "customers.listCustomers" ? SEARCH : CUSTOMER;
  const span = params[slot];
  if (target === undefined || typeof span !== "string" || knownNameAt(nameWords(span), context.customers) !== null || customerSaid(utterance)) return null;
  const named = context.productsNamed(wordsOf(span));
  if (named === 0) return null;
  const listed = target === GET_PRODUCT && (named > 1 || listAsked(utterance, span)) ? LIST_PRODUCTS : target;
  if (!known(bundle, listed)) return null;
  const rest = Object.fromEntries(Object.entries(params).filter(([name]) => name !== slot));
  return { action: listed, params: kept(bundle, listed, { [listed === LIST_PRODUCTS ? SEARCH : PRODUCT]: span, ...rest }) };
}

// The longest run of words around a product span that names one catalogue product, the whole name before a part, over no word another param said:
// «kerastase» → «шампунь kerastase», «chelsea» → «черевиків chelsea», «pro» → «iphone 15 pro».
export function widenedProduct(utterance: string, span: string, taken: readonly string[], catalogue: CompiledContext): string {
  const words = wordsOf(utterance);
  const start = wordIndex(words, span);
  if (start < 0) return span;
  const end = start + wordsOf(span).length;
  const blocked = new Set(taken.flatMap((other) => {
    const at = wordIndex(words, other);
    return at < 0 ? [] : wordsOf(other).map((_, offset) => at + offset);
  }));
  let best: Window | null = null;
  for (let from = start; from >= Math.max(0, start - catalogue.longest) && (from === start || !blocked.has(from)); from--) {
    for (let to = end; to <= Math.min(words.length, end + catalogue.longest) && (to === end || !blocked.has(to - 1)); to++) {
      const hit = catalogue.find(words.slice(from, to));
      if (hit?.kind !== "product") continue;
      const window: Window = [Number(hit.fit === "whole"), to - from, from, to];
      if (best === null || window[0] > best[0] || (window[0] === best[0] && window[1] > best[1])) best = window;
    }
  }
  return best === null ? span : words.slice(best[2], best[3]).join(" ");
}

// D73: «скільки лишилось смородинового зефіру», «бордового лаку есі», «чорних легінсів M», «скільки флаконів біодерми продали»: a single-product span the
// catalogue does not know, with the attr spans said right beside it, holds a run of words that names one catalogue product (the whole name before a part,
// the longest); every other word of it is an attr value the catalogue knows, a label word or a container or unit word («флаконів», «пачок»). The product
// is that run, the attr words join the attrs (in the order said), the container words go; an attr span the run took is no attr any more.
interface Narrowed {
  readonly product: string;
  readonly attrs: readonly string[];
}

function catalogued(context: CompiledContext, words: readonly string[]): boolean {
  if (!words.length) return false;
  const hit = context.find(words);
  if (hit?.kind === "product") return true;
  const hits = context.records.products(words.join(" "));
  return hits.whole.length + hits.part.length + hits.named.length > 0;
}

export function narrowedProduct(utterance: string, span: string, attrs: readonly string[], context: CompiledContext): Narrowed | null {
  const words = wordsOf(utterance);
  const own = wordsOf(span);
  const start = wordIndex(words, span);
  if (start < 0 || catalogued(context, own)) return null;
  let from = start;
  let to = start + own.length;
  const spoken = attrs.map(wordsOf);
  // The attr spans said right before or after the span.
  for (let grown = true; grown; ) {
    grown = false;
    for (const attr of spoken) {
      if (attr.length && attr.every((word, offset) => words[to + offset] === word)) {
        to += attr.length;
        grown = true;
      } else if (attr.length && from - attr.length >= 0 && attr.every((word, offset) => words[from - attr.length + offset] === word)) {
        from -= attr.length;
        grown = true;
      }
    }
  }
  const aside = (word: string) => UNITS.has(word) || LABEL_WORDS.has(word) || context.match([word]) === "variant";
  let best: readonly [whole: number, length: number, a: number, b: number] | null = null;
  for (let a = from; a < to; a++) {
    for (let b = a + 1; b <= to && b - a <= context.longest; b++) {
      const run = words.slice(a, b);
      const hit = context.find(run);
      if (hit?.kind !== "product" || !words.slice(from, a).every(aside) || !words.slice(b, to).every(aside)) continue;
      const found = [Number(hit.fit === "whole"), b - a, a, b] as const;
      if (best === null || found[0] > best[0] || (found[0] === best[0] && found[1] > best[1])) best = found;
    }
  }
  if (best === null) return null;
  const [, , a, b] = best;
  const outside = [...words.slice(from, a), ...words.slice(b, to)].filter((word) => !UNITS.has(word) && !LABEL_WORDS.has(word));
  const taken = new Set(words.slice(a, b));
  const kept = attrs.filter((attr) => !wordsOf(attr).every((word) => taken.has(word)) && !wordsOf(attr).every((word) => outside.includes(word)));
  const before = words.slice(from, a).filter((word) => outside.includes(word));
  const after = words.slice(b, to).filter((word) => outside.includes(word));
  // Each attr word said apart is one attr, as the model tags them; a spoken attr span keeps its words together.
  const regrouped = (list: readonly string[]) => {
    const out: string[] = [];
    for (let at = 0; at < list.length; ) {
      const whole = attrs.find((attr) => wordsOf(attr).every((word, offset) => list[at + offset] === word));
      const size = whole === undefined ? 1 : wordsOf(whole).length;
      out.push(list.slice(at, at + size).join(" "));
      at += size;
    }
    return out;
  };
  return { product: words.slice(a, b).join(" "), attrs: [...regrouped(before), ...regrouped(after), ...kept.filter((attr) => !regrouped([...before, ...after]).includes(attr))] };
}

function spanValues(params: Params, except: string): string[] {
  return Object.entries(params).flatMap(([name, value]) => (name !== except && typeof value === "string" ? [value] : []));
}

// The product readings in order: a customer action turned to its product counterpart, every product param (and a product list's search text) widened to
// the catalogue name it is part of, and a get said with «всі» a list. Order lines are the catalogue pass's (`catalogue.ts`), not these.
export function productReading(bundle: Pick<Bundle, "intents">, action: ActionName, params: Params, utterance: string, context: CompiledContext): ProductReading {
  const turned = counterpart(bundle, action, params, utterance, context) ?? { action, params };
  const types = intentOfAction(bundle, turned.action).intent.params;
  const widened: Record<string, ParamValue> = { ...turned.params };
  for (const [name, type] of Object.entries(types)) {
    const span = widened[name];
    const searched = turned.action === LIST_PRODUCTS && name === SEARCH;
    if ((type === PRODUCT || searched) && typeof span === "string") widened[name] = widenedProduct(utterance, span, spanValues(widened, name), context);
  }
  // D73: a product span the catalogue does not know that holds attr or container words around a product's name, in an intent that takes attrs (v3
  // `stock.get`, `stock.set`, `analytics.summary`, a variant's `attrs`); a v2 bundle has no such param.
  const attrsName = Object.keys(types).find((name) => types[name] === ATTRS);
  const product = widened[PRODUCT];
  if (types[PRODUCT] === PRODUCT && attrsName !== undefined && typeof product === "string") {
    const said = widened[attrsName];
    const narrowed = narrowedProduct(utterance, product, isNames(said) ? said : [], context);
    if (narrowed !== null) {
      widened[PRODUCT] = narrowed.product;
      if (narrowed.attrs.length) widened[attrsName] = narrowed.attrs;
      else delete widened[attrsName];
    }
  }
  const productSaid = widened[PRODUCT];
  if (turned.action === GET_PRODUCT && typeof productSaid === "string" && listAsked(utterance, productSaid) && known(bundle, LIST_PRODUCTS)) {
    const rest = Object.fromEntries(Object.entries(widened).filter(([name]) => name !== PRODUCT));
    return { action: LIST_PRODUCTS, params: kept(bundle, LIST_PRODUCTS, { [SEARCH]: productSaid, ...rest }) };
  }
  return { action: turned.action, params: widened };
}
