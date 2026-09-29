import type { Bundle } from "./bundle.ts";
import type { CompiledContext } from "./catalogue.ts";
import type { ParamValue, Params } from "./params.ts";

// D72: a shop that tracks no stock (context v2 `capabilities.stock: false`). The model still hears «чи є ще капкейки» as `stock.get`; the runtime serves
// the question the shop can answer, the catalogue's: `catalog.getProduct {product}` (is the product in the catalogue, and is it active; no quantity), and
// a stock list that searches (`stock.list {search_text}`) as `catalog.listProducts {search_text}`. The command carries the need `{path: "stock", reason:
// "unsupported"}` so the app knows what was asked: not blocking where the catalogue answers, blocking where it cannot (a list by stock level, a stock
// write). With stock tracked, or without a context, nothing changes.

export interface Unsupported {
  readonly path: "stock";
  readonly blocking: boolean;
}

export interface Stockless {
  readonly action: string;
  readonly params: Params;
  readonly unsupported: Unsupported;
}

const STOCK_GET = "stock.get";
const STOCK_LIST = "stock.list";
const STOCK_DOMAIN = "stock.";
const PRODUCT_CARD = "catalog.getProduct";
const PRODUCT_LIST = "catalog.listProducts";
const PRODUCT = "product";
const SEARCH_TEXT = "search_text";
const STOCK_LEVEL = "stock_level";

function kept(params: Params, name: string): Record<string, ParamValue> {
  const value = params[name];
  return value === undefined ? {} : { [name]: value };
}

export function stockless(bundle: Pick<Bundle, "intents">, action: string, params: Params, context: CompiledContext): Stockless | null {
  if (context.records.shop.stock || !action.startsWith(STOCK_DOMAIN)) return null;
  const has = (name: string) => Object.hasOwn(bundle.intents, name);
  if (action === STOCK_GET && has(PRODUCT_CARD)) return { action: PRODUCT_CARD, params: kept(params, PRODUCT), unsupported: { path: "stock", blocking: false } };
  if (action === STOCK_LIST && params[STOCK_LEVEL] === undefined && has(PRODUCT_LIST)) return { action: PRODUCT_LIST, params: kept(params, SEARCH_TEXT), unsupported: { path: "stock", blocking: false } };
  return { action, params, unsupported: { path: "stock", blocking: true } };
}
