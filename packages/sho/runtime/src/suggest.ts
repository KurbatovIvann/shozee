import { ORDER_LINES, intentOfAction, listItemType, type Bundle, type Intent, type ParamType } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { RecordList, ShopProduct } from "./context.ts";
import { productIndex, recordIndex, variantIndex, type NearIndex } from "./nearest.ts";
import { nominativeName } from "./nominative.ts";
import type { Records } from "./records.ts";
import type { Attr, NearCandidate, OrderItem, Param, Ref, Suggestion, VariantParam } from "./result.ts";

// D78 (sho-api-v2.md §3.1, §8.10): what the card can offer for a name the context does not know. Every ref with `status: "unknown"` (a product, a customer,
// a group, a price list, a counterparty, a product of an order line) and every attr no variant of its resolved product has gets `nearest`, the records of
// that list near its words (`nearest.ts`), and `suggest`, the create command with the words as said. Additive: a host that reads neither sees the
// result it saw before.

type Kind = "products" | RecordList;

const CREATE: Readonly<Record<Kind, string>> = {
  products: "catalog.createProduct",
  customers: "customers.createCustomer",
  groups: "customers.createGroup",
  priceLists: "pricing.createPriceList",
  counterparties: "customers.createCounterparty",
};
const CREATE_VARIANT = "catalog.createVariant";
const NAME_PARAMS: readonly string[] = ["new_name", "name"];
const PRODUCT = "product";
const LIST_OF: Readonly<Record<string, Kind>> = { customer: "customers", group: "groups", price_list: "priceLists", counterparty: "counterparties", product: "products" };

const INDICES = new WeakMap<Records, Map<string, NearIndex>>();

function indexOf(records: Records, key: string, build: () => NearIndex | null): NearIndex | null {
  let known = INDICES.get(records);
  if (known === undefined) {
    known = new Map();
    INDICES.set(records, known);
  }
  const found = known.get(key);
  if (found !== undefined) return found;
  const built = build();
  if (built !== null) known.set(key, built);
  return built;
}

function listIndex(records: Records, kind: Kind): NearIndex | null {
  return indexOf(records, kind, () => {
    if (kind === "products") return records.shop.products === null ? null : productIndex(records.shop.products);
    const list = records.shop.lists[kind];
    return list === null ? null : recordIndex(list);
  });
}

function isRef(param: Param | undefined): param is Ref {
  return param !== undefined && !Array.isArray(param) && "status" in param && "text" in param && !("attrs" in param);
}

function isAttrs(param: Param | undefined): param is readonly Attr[] {
  return Array.isArray(param) && param.every((item: unknown) => typeof item === "object" && item !== null && "variantIds" in item);
}

function isItems(param: Param | undefined): param is readonly OrderItem[] {
  return Array.isArray(param) && param.length > 0 && param.every((item: unknown) => typeof item === "object" && item !== null && "product" in item && "quantity" in item);
}

function isVariantParam(param: Param | undefined): param is VariantParam {
  return param !== undefined && !Array.isArray(param) && "attrs" in param && "status" in param;
}

class Suggester {
  private readonly bundle: Bundle;
  private readonly records: Records;
  private readonly own: Intent;
  private readonly params: Readonly<Record<string, Param>>;

  constructor(bundle: Bundle, records: Records, own: Intent, params: Readonly<Record<string, Param>>) {
    this.bundle = bundle;
    this.records = records;
    this.own = own;
    this.params = params;
  }

  // The create command for a name, with the command's own params the create intent takes with the same type; null when the bundle has no such intent.
  // D82: a new customer's name said in another case has its nominative as the name param's `value` («гришу» {text «гришу», value «Гриша»}).
  private suggestion(action: string, text: string, given: Readonly<Record<string, Param>>, attrs: readonly string[] = [], nominative: string | null = null): Suggestion | null {
    if (!Object.hasOwn(this.bundle.intents, action)) return null;
    const { action: name, intent } = intentOfAction(this.bundle, action);
    const nameParam = NAME_PARAMS.find((param) => Object.hasOwn(intent.params, param));
    if (nameParam === undefined) return null;
    const params: Record<string, Param> = { ...given, [nameParam]: nominative === null ? { text } : { text, value: nominative } };
    for (const [param, type] of Object.entries(intent.params)) {
      if (Object.hasOwn(params, param) || !Object.hasOwn(this.params, param) || this.own.params[param] !== type) continue;
      const value = this.params[param];
      if (value !== undefined && !isRef(value)) params[param] = value;
    }
    return { action: name, params, ...(attrs.length ? { attrs } : {}) };
  }

  private nearest(kind: Kind, text: string): readonly NearCandidate[] {
    return listIndex(this.records, kind)?.nearest(text) ?? [];
  }

  ref(ref: Ref, kind: Kind, attrs: readonly string[] = []): Ref {
    if (ref.status !== "unknown") return ref;
    const suggest = this.suggestion(CREATE[kind], ref.text, {}, attrs, kind === "customers" ? nominativeName(ref.text) : null);
    const nearest = this.nearest(kind, ref.text);
    return { ...ref, ...(nearest.length ? { nearest } : {}), ...(suggest === null ? {} : { suggest }) };
  }

  private product(ref: Ref): ShopProduct | null {
    if (ref.status !== "resolved" || typeof ref.id !== "string") return null;
    return this.records.shop.products?.find((product) => product.id === ref.id) ?? null;
  }

  // The attrs no variant of the resolved product has: the product's variants near each, and the variant to create (the line's attrs as said) unless the
  // other attrs already name one variant (the attr is then a note on it, sho-api-v2.md §7 Q2).
  attrs(attrs: readonly Attr[], product: Ref | undefined, named = false): Attr[] {
    const found = product === undefined ? null : this.product(product);
    if (found === null || product === undefined || found.variants === null || !found.variants.length) return [...attrs];
    const index = indexOf(this.records, `variants:${found.id ?? found.name}`, () => variantIndex(found));
    const said = attrs.map((attr) => attr.text).join(" ");
    const plain: Ref = { text: product.text, status: product.status, ...(product.id === undefined ? {} : { id: product.id }), ...(product.name === undefined ? {} : { name: product.name }) };
    return attrs.map((attr) => {
      if (attr.variantIds === null || attr.variantIds.length) return attr;
      const suggest = named ? null : this.suggestion(CREATE_VARIANT, said, { [PRODUCT]: plain });
      const nearest = index?.nearest(attr.text) ?? [];
      return { ...attr, ...(nearest.length ? { nearest } : {}), ...(suggest === null ? {} : { suggest }) };
    });
  }

  item(item: OrderItem): OrderItem {
    if (item.product.status === "unknown") return { ...item, product: this.ref(item.product, "products", item.attrs.map((attr) => attr.text)) };
    return { ...item, attrs: this.attrs(item.attrs, item.product, item.variant.status === "resolved") };
  }
}

function listKind(bundle: Bundle, type: ParamType | undefined): Kind | undefined {
  if (type === undefined) return undefined;
  const own = Object.hasOwn(LIST_OF, type) ? LIST_OF[type] : undefined;
  if (own !== undefined) return own;
  const item = listItemType(bundle, type);
  return item !== undefined && Object.hasOwn(LIST_OF, item) ? LIST_OF[item] : undefined;
}

// The command's params with `nearest` and `suggest` on what the context does not know; the params as they were without a context.
export function withSuggestions(bundle: Bundle, action: string, params: Readonly<Record<string, Param>>, context: CompiledContext | null): Readonly<Record<string, Param>> {
  if (context === null || context.empty) return params;
  const { intent } = intentOfAction(bundle, action);
  const suggester = new Suggester(bundle, context.records, intent, params);
  const product = params[PRODUCT];
  const productRef = isRef(product) ? product : undefined;
  const saidAttrs = Object.values(params).flatMap((param) => (isAttrs(param) ? param.map((attr) => attr.text) : isVariantParam(param) ? param.attrs.map((attr) => attr.text) : []));
  const out: Record<string, Param> = {};
  for (const [name, param] of Object.entries(params)) {
    const type = Object.hasOwn(intent.params, name) ? intent.params[name] : undefined;
    const kind = listKind(bundle, type);
    if (type === ORDER_LINES && isItems(param)) out[name] = param.map((item) => suggester.item(item));
    else if (kind !== undefined && isRef(param)) out[name] = suggester.ref(param, kind, kind === "products" ? saidAttrs : []);
    else if (kind !== undefined && Array.isArray(param) && param.every((item: unknown) => isRef(item as Param))) out[name] = (param as readonly Ref[]).map((ref) => suggester.ref(ref, kind));
    else if (isAttrs(param) && param.length) out[name] = suggester.attrs(param, productRef);
    else if (isVariantParam(param)) out[name] = { ...param, attrs: suggester.attrs(param.attrs, productRef, param.status === "resolved") };
    else out[name] = param;
  }
  return out;
}
