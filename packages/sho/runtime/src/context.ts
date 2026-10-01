import { InputError } from "./errors.ts";
import { COLOUR_COUNTS } from "./lexicon/catalogue.ts";
import { CAPITAL_UNITS, COUNT_WORDS, SALE_UNITS, UNIT_KEYS, type SaleUnit } from "./lexicon/units.ts";
import { nameTokens } from "./nameTokens.ts";
import { tyreParts } from "./tyres.ts";
import { wordMatch } from "./words.ts";

// The shop's catalogue context (docs/design/sho-api-v2.md §2, D65): the flat v1 lists of names, or the v2 records with ids, variants and aliases. Both
// compile through one normalised form, `Shop`: a v1 context is a v2 one whose products have no ids and whose flat variants are a shop-wide attribute
// vocabulary that never resolves a variant.

export interface ContextV1 {
  readonly products: readonly string[];
  readonly variants: readonly string[];
  readonly customers: readonly string[];
}

// Attribute values of a variant: a list, or a map from an axis name («Колір») to a value; axis names only label candidates.
export type AttrValues = readonly string[] | Readonly<Record<string, string>>;

export interface VariantV2 {
  readonly id: string;
  readonly name: string;
  readonly values?: AttrValues;
  readonly aliases?: readonly string[];
}

export interface ProductV2 {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly brand?: string;
  readonly unit?: SaleUnit;
  readonly variants?: readonly VariantV2[];
}

export interface RecordV2 {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
}

// D94: a customer may carry its phones and e-mails, so a customer said by one («знайди клієнта з номером …») is resolved on the device. Optional: a
// host that keeps contacts off the device sends none, and the contact goes back to it as said.
export interface CustomerV2 extends RecordV2 {
  readonly phones?: readonly string[];
  readonly emails?: readonly string[];
}

export type RecordList = "customers" | "groups" | "priceLists" | "counterparties";
export type ListName = "products" | RecordList;

// What the shop's back office does (D72). `stock`: whether it tracks stock; absent means it does, so a context without the field reads as before.
// D89: `fiscal`, whether it has a till (a ПРРО): money given back is a till return with one, a refund without; absent means the runtime does not know,
// and the model's reading stands.
export interface Capabilities {
  readonly stock?: boolean;
  readonly fiscal?: boolean;
}

export interface ContextV2 {
  readonly version: 2;
  readonly revision?: string;
  readonly capabilities?: Capabilities;
  readonly products?: readonly ProductV2[];
  readonly customers?: readonly CustomerV2[];
  readonly groups?: readonly RecordV2[];
  readonly priceLists?: readonly RecordV2[];
  readonly counterparties?: readonly RecordV2[];
  readonly partial?: readonly ListName[];
}

export type Context = ContextV1 | ContextV2;

export const CONTEXT_LIMITS = {
  products: 20_000,
  variantsPerProduct: 200,
  variants: 100_000,
  customers: 50_000,
  counterparties: 50_000,
  groups: 2_000,
  priceLists: 2_000,
  id: 64,
  name: 120,
  aliases: 10,
  contacts: 10,
  contact: 254,
  revision: 128,
  bytes: 8 * 1024 * 1024,
} as const;

export const RECORD_LISTS: readonly RecordList[] = ["customers", "groups", "priceLists", "counterparties"];
const LIST_NAMES: readonly ListName[] = ["products", ...RECORD_LISTS];
const V1_KEYS: ReadonlySet<string> = new Set(["products", "variants", "customers"]);
const V2_KEYS: ReadonlySet<string> = new Set(["version", "revision", "partial", "capabilities", ...LIST_NAMES]);
const CAPABILITY_KEYS: ReadonlySet<string> = new Set(["stock", "fiscal"]);
const PRODUCT_KEYS: ReadonlySet<string> = new Set(["id", "name", "aliases", "brand", "unit", "variants"]);
const VARIANT_KEYS: ReadonlySet<string> = new Set(["id", "name", "values", "aliases"]);
const RECORD_KEYS: ReadonlySet<string> = new Set(["id", "name", "aliases"]);
const CUSTOMER_KEYS: ReadonlySet<string> = new Set([...RECORD_KEYS, "phones", "emails"]);

type Json = Readonly<Record<string, unknown>>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new InputError("context", message);
}

function limit(count: number, most: number, what: string): void {
  if (count > most) throw new InputError("context_limit", `${what} has ${count} entries, the limit is ${most}`);
}

function onlyKeys(json: Json, known: ReadonlySet<string>, what: string): void {
  const unknown = Object.keys(json).filter((key) => !known.has(key));
  if (unknown.length) fail(`${what} has unknown keys ${unknown.join(", ")}`);
}

function names(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) fail(`context ${what} is not a list of strings`);
  return value;
}

function text(value: unknown, most: number, what: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${what} is not a non-empty string`);
  if (value.length > most) throw new InputError("context_limit", `${what} is longer than ${most} characters`);
  return value;
}

function aliasesOf(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  const found = names(value, `${what}.aliases`);
  limit(found.length, CONTEXT_LIMITS.aliases, `${what}.aliases`);
  return found.map((alias, index) => text(alias, CONTEXT_LIMITS.name, `${what}.aliases[${index}]`));
}

function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${what} is not a list`);
  return value;
}

function uniqueIds(records: readonly { readonly id: string }[], what: string): void {
  const seen = new Set<string>();
  for (const { id } of records) {
    if (seen.has(id)) fail(`${what} has the id ${id} twice`);
    seen.add(id);
  }
}

function valuesOf(value: unknown, what: string): AttrValues | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return names(value, what).map((item, index) => text(item, CONTEXT_LIMITS.name, `${what}[${index}]`));
  if (!isJson(value)) fail(`${what} is neither a list nor an object of strings`);
  return Object.fromEntries(Object.entries(value).map(([axis, item]) => [axis, text(item, CONTEXT_LIMITS.name, `${what}.${axis}`)]));
}

function contactsOf(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  const found = names(value, what);
  limit(found.length, CONTEXT_LIMITS.contacts, what);
  return found.map((contact, index) => text(contact, CONTEXT_LIMITS.contact, `${what}[${index}]`));
}

// `contacts` (D94): a customer, which may carry `phones` and `emails`; any other record has only its id, name and aliases.
function recordOf(value: unknown, what: string, contacts = false): CustomerV2 {
  if (!isJson(value)) fail(`${what} is not an object`);
  onlyKeys(value, contacts ? CUSTOMER_KEYS : RECORD_KEYS, what);
  const aliases = aliasesOf(value["aliases"], what);
  const phones = contacts ? contactsOf(value["phones"], `${what}.phones`) : undefined;
  const emails = contacts ? contactsOf(value["emails"], `${what}.emails`) : undefined;
  return {
    id: text(value["id"], CONTEXT_LIMITS.id, `${what}.id`),
    name: text(value["name"], CONTEXT_LIMITS.name, `${what}.name`),
    ...(aliases === undefined ? {} : { aliases }),
    ...(phones === undefined ? {} : { phones }),
    ...(emails === undefined ? {} : { emails }),
  };
}

function variantOf(value: unknown, what: string): VariantV2 {
  if (!isJson(value)) fail(`${what} is not an object`);
  onlyKeys(value, VARIANT_KEYS, what);
  const values = valuesOf(value["values"], `${what}.values`);
  const aliases = aliasesOf(value["aliases"], what);
  return {
    id: text(value["id"], CONTEXT_LIMITS.id, `${what}.id`),
    name: text(value["name"], CONTEXT_LIMITS.name, `${what}.name`),
    ...(values === undefined ? {} : { values }),
    ...(aliases === undefined ? {} : { aliases }),
  };
}

function isSaleUnit(value: string): value is SaleUnit {
  return SALE_UNITS.some((unit) => unit === value);
}

function productOf(value: unknown, what: string): ProductV2 {
  if (!isJson(value)) fail(`${what} is not an object`);
  onlyKeys(value, PRODUCT_KEYS, what);
  const aliases = aliasesOf(value["aliases"], what);
  const brand = value["brand"] === undefined ? undefined : text(value["brand"], CONTEXT_LIMITS.name, `${what}.brand`);
  const unit = value["unit"];
  if (unit !== undefined && (typeof unit !== "string" || !isSaleUnit(unit))) fail(`${what}.unit is not one of ${SALE_UNITS.join(", ")}`);
  const variants = value["variants"] === undefined ? undefined : list(value["variants"], `${what}.variants`).map((variant, index) => variantOf(variant, `${what}.variants[${index}]`));
  if (variants !== undefined) {
    limit(variants.length, CONTEXT_LIMITS.variantsPerProduct, `${what}.variants`);
    uniqueIds(variants, `${what}.variants`);
  }
  return {
    id: text(value["id"], CONTEXT_LIMITS.id, `${what}.id`),
    name: text(value["name"], CONTEXT_LIMITS.name, `${what}.name`),
    ...(aliases === undefined ? {} : { aliases }),
    ...(brand === undefined ? {} : { brand }),
    ...(unit === undefined ? {} : { unit }),
    ...(variants === undefined ? {} : { variants }),
  };
}

function records(value: unknown, name: RecordList): CustomerV2[] {
  const found = list(value, name).map((record, index) => recordOf(record, `${name}[${index}]`, name === "customers"));
  limit(found.length, CONTEXT_LIMITS[name], name);
  uniqueIds(found, name);
  return found;
}

function capabilitiesOf(value: unknown): Capabilities {
  if (!isJson(value)) fail("capabilities is not an object");
  onlyKeys(value, CAPABILITY_KEYS, "capabilities");
  const stock = value["stock"];
  if (stock !== undefined && typeof stock !== "boolean") fail("capabilities.stock is not a boolean");
  const fiscal = value["fiscal"];
  if (fiscal !== undefined && typeof fiscal !== "boolean") fail("capabilities.fiscal is not a boolean");
  return { ...(stock === undefined ? {} : { stock }), ...(fiscal === undefined ? {} : { fiscal }) };
}

function isListName(value: unknown): value is ListName {
  return LIST_NAMES.some((name) => name === value);
}

function contextV2Of(json: Json): ContextV2 {
  onlyKeys(json, V2_KEYS, "the context");
  const revision = json["revision"] === undefined ? undefined : text(json["revision"], CONTEXT_LIMITS.revision, "revision");
  const products = json["products"] === undefined ? undefined : list(json["products"], "products").map((product, index) => productOf(product, `products[${index}]`));
  if (products !== undefined) {
    limit(products.length, CONTEXT_LIMITS.products, "products");
    uniqueIds(products, "products");
    limit(products.reduce((count, product) => count + (product.variants?.length ?? 0), 0), CONTEXT_LIMITS.variants, "variants");
  }
  const partial = json["partial"] === undefined ? undefined : list(json["partial"], "partial");
  if (partial !== undefined && !partial.every(isListName)) fail(`partial names a list other than ${LIST_NAMES.join(", ")}`);
  const lists = Object.fromEntries(RECORD_LISTS.flatMap((name) => (json[name] === undefined ? [] : [[name, records(json[name], name)] as const])));
  const capabilities = json["capabilities"] === undefined ? undefined : capabilitiesOf(json["capabilities"]);
  return {
    version: 2,
    ...(revision === undefined ? {} : { revision }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(products === undefined ? {} : { products }),
    ...lists,
    ...(partial === undefined ? {} : { partial: partial.filter(isListName) }),
  };
}

// A context as JSON: v1 (no `version`, flat `products`, `variants`, `customers` string lists) or v2 (`"version": 2`). Throws `InputError` "context" for a
// malformed one and "context_limit" when a list is over its limit (§2.4).
export function parseContext(json: unknown): Context {
  if (!isJson(json)) fail("the context is not a JSON object");
  const version = json["version"];
  if (version === 2) return contextV2Of(json);
  if (version !== undefined) fail(`the context version ${String(version)} is not 2`);
  onlyKeys(json, V1_KEYS, "the context");
  return { products: names(json["products"] ?? [], "products"), variants: names(json["variants"] ?? [], "variants"), customers: names(json["customers"] ?? [], "customers") };
}

export function isContextV2(context: Context): context is ContextV2 {
  return "version" in context;
}

// The normalised context the runtime compiles.

export interface ShopVariant {
  readonly id: string;
  readonly name: string;
  // The attribute values the variant's attrs are matched against, as the shop wrote them.
  readonly values: readonly string[];
  readonly aliases: readonly string[];
  // «Колір: червона, Розмір: 44» when the values came with axis names.
  readonly label: string | null;
}

export interface ShopProduct {
  readonly id: string | null;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly brand: string | null;
  readonly unit: SaleUnit | null;
  // null: a v1 product, whose variants the context does not know.
  readonly variants: readonly ShopVariant[] | null;
}

export interface ShopRecord {
  readonly id: string | null;
  readonly name: string;
  readonly aliases: readonly string[];
  // D94: a customer's phones and e-mails, when the context gave them.
  readonly phones?: readonly string[];
  readonly emails?: readonly string[];
}

export interface Shop {
  readonly version: 1 | 2;
  readonly revision: string | null;
  // null: the list is not in the context, so its refs are "unchecked".
  readonly products: readonly ShopProduct[] | null;
  // Every attribute word the shop's variants know, for the segmenter: the v1 flat variants, or the union of the v2 variants' values and aliases.
  readonly vocabulary: readonly string[];
  readonly lists: Readonly<Record<RecordList, readonly ShopRecord[] | null>>;
  readonly partial: ReadonlySet<ListName>;
  // D72: false when the shop tracks no stock (context v2 `capabilities.stock: false`); a v1 context and a v2 one without the field track it.
  readonly stock: boolean;
  // D89: whether the shop has a till (context v2 `capabilities.fiscal`); null when the context does not say (a v1 context, a v2 one without the field).
  readonly fiscal: boolean | null;
}

// Spaces split a name, and a «,» that is no decimal comma («0,5 л» is one value, D66).
const SPLIT = /\s+|(?<![0-9]),|,(?![0-9])/;
// «/» between two numbers is part of a value («25/4», «205/55»): only a «/» between words splits a name (D66).
const SLASH = /(?<![0-9])\/|\/(?![0-9])/g;
// A tyre size is one value («205/55 R16»), whatever else the name says (D66, `tyres.ts`).
const TYRE = /[0-9]{3}\/[0-9]{2}\s*[RrРр]\s*[0-9]{2}/u;
// `wordMatch` needs three letters in common at the start, so a word that starts otherwise repeats none of the product's.
const COMMON_START = 3;

function repeats(word: string, own: readonly string[]): boolean {
  return own.some((known) => word === known || (word.slice(0, COMMON_START) === known.slice(0, COMMON_START) && wordMatch(word, known)));
}
// A number, or a range of two («9-18 кг», D67).
const NUMBER = /^[0-9]+(?:[.,][0-9]+)?(?:[-–][0-9]+(?:[.,][0-9]+)?)?$/;

// A variant's values when the host sent none (§2.1): its name split on spaces, «/» and «,», a number kept with the unit after it («256 ГБ», and the capital
// «16 А», «220 В» since D67, «9 шт» since D71), without the words that repeat the product's name («Сукня вечірня чорна 42» → «чорна», «42»). A «/» between numbers and a
// tyre size stay in one value (D66).
export function derivedValues(productName: string, variantName: string): string[] {
  const own = productName.toLowerCase().replace(SLASH, " ").split(SPLIT).filter(Boolean);
  const tyre = TYRE.exec(variantName)?.[0];
  const rest = tyre === undefined ? variantName : variantName.replace(tyre, " ");
  const words = rest.replace(SLASH, " ").split(SPLIT).filter(Boolean);
  const values: string[] = tyre === undefined ? [] : [tyre];
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? "";
    const next = words[at + 1];
    if (NUMBER.test(word) && next !== undefined && (UNIT_KEYS.has(next.toLowerCase()) || CAPITAL_UNITS.has(next) || COLOUR_COUNTS.has(next.toLowerCase()) || COUNT_WORDS.has(next.toLowerCase()))) {
      values.push(`${word} ${next}`);
      at += 1;
    } else if (!repeats(word.toLowerCase(), own)) values.push(word);
  }
  return values.length ? values : [variantName];
}

function shopVariant(product: ProductV2, variant: VariantV2): ShopVariant {
  const given = variant.values;
  const values = given === undefined ? derivedValues(product.name, variant.name) : Array.isArray(given) ? [...given] : Object.values(given);
  const label = given !== undefined && !Array.isArray(given) ? Object.entries(given).map(([axis, value]) => `${axis}: ${value}`).join(", ") : null;
  const parts = values.flatMap((value) => (TYRE.test(value) ? tyreParts(value, nameTokens(value)) : []));
  return { id: variant.id, name: variant.name, values, aliases: [...(variant.aliases ?? []), ...parts.filter((part) => !values.includes(part))], label };
}

function shopRecord(record: CustomerV2): ShopRecord {
  return { id: record.id, name: record.name, aliases: record.aliases ?? [], ...(record.phones?.length ? { phones: record.phones } : {}), ...(record.emails?.length ? { emails: record.emails } : {}) };
}

function uniqueFolded(words: readonly string[]): string[] {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A v1 list as records without ids: blank names left out, a name said twice kept once (products by their lowercase name, as the segmenter reads them).
function v1Records(names: readonly string[], fold: boolean): ShopRecord[] | null {
  const kept = fold ? uniqueFolded(names) : [...new Set(names)];
  const records = kept.filter((name) => name.trim()).map((name) => ({ id: null, name, aliases: [] }));
  return records.length ? records : null;
}

export function shopOf(context: Context): Shop {
  if (!isContextV2(context)) {
    const products = v1Records(context.products, true);
    return {
      version: 1,
      revision: null,
      products: products === null ? null : products.map((record) => ({ ...record, brand: null, unit: null, variants: null })),
      vocabulary: context.variants,
      lists: { customers: v1Records(context.customers, false), groups: null, priceLists: null, counterparties: null },
      partial: new Set(),
      stock: true,
      fiscal: null,
    };
  }
  const products = context.products?.map((product): ShopProduct => ({
    id: product.id,
    name: product.name,
    aliases: product.aliases ?? [],
    brand: product.brand ?? null,
    unit: product.unit ?? null,
    variants: (product.variants ?? []).map((variant) => shopVariant(product, variant)),
  }));
  const vocabulary = uniqueFolded((products ?? []).flatMap((product) => (product.variants ?? []).flatMap((variant) => [...variant.values, ...variant.aliases])));
  const listOf = (name: RecordList): readonly ShopRecord[] | null => context[name]?.map(shopRecord) ?? null;
  return {
    version: 2,
    revision: context.revision ?? null,
    products: products ?? null,
    vocabulary,
    lists: { customers: listOf("customers"), groups: listOf("groups"), priceLists: listOf("priceLists"), counterparties: listOf("counterparties") },
    partial: new Set(context.partial ?? []),
    stock: context.capabilities?.stock !== false,
    fiscal: context.capabilities?.fiscal ?? null,
  };
}
