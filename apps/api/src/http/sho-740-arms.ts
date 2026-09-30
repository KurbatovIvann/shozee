export const SHO_740_READ_TOOLS: Readonly<Record<string, string>> = {
  "orders.list": "orders_list_page",
  "orders.count": "orders_list_counts",
  "orders.get": "orders_get",
  "customers.listCustomers": "customers_list_customers",
  "customers.getCustomer": "customers_getCustomer",
  "customers.listGroups": "customers_list_groups",
  "customers.getGroup": "customers_getGroup",
  "customers.listCounterparties": "customers_listCounterparties",
  "customers.getCounterparty": "customers_getCounterparty",
  "catalog.listProducts": "catalog_list_products",
  "catalog.getProduct": "catalog_getProduct",
  "pricing.listPriceLists": "pricing_list_price_lists",
  "pricing.getPriceList": "pricing_getPriceList",
  "pricing.listPriceListEntries": "pricing_listPriceListEntries",
  "documents.list": "documents_list",
  "documents.get": "documents_get",
  "docGeneration.listLayouts": "docGeneration_listLayouts",
  "search.query": "search_query",
};

export const SHO_740_WRITE_TOOLS: Readonly<Record<string, string>> = {
  "orders.create": "orders_create",
  "orders.confirm": "orders_confirm",
  "orders.start": "orders_start",
  "orders.complete": "orders_complete",
  "orders.cancel": "orders_cancel",
  "customers.createCustomer": "customers_createCustomer",
  "customers.updateCustomer": "customers_updateCustomer",
  "customers.archiveCustomer": "customers_archiveCustomer",
  "customers.restoreCustomer": "customers_restoreCustomer",
  "customers.deleteCustomer": "customers_deleteCustomer",
  "customers.createGroup": "customers_createGroup",
  "customers.updateGroup": "customers_updateGroup",
  "customers.deleteGroup": "customers_deleteGroup",
  "customers.createCounterparty": "customers_createCounterparty",
  "customers.updateCounterparty": "customers_updateCounterparty",
  "customers.deleteCounterparty": "customers_deleteCounterparty",
  "catalog.createProduct": "catalog_createProduct",
  "catalog.updateProduct": "catalog_updateProduct",
  "catalog.archiveProduct": "catalog_archiveProduct",
  "catalog.restoreProduct": "catalog_restoreProduct",
  "catalog.createVariant": "catalog_createVariant",
  "catalog.updateVariant": "catalog_updateVariant",
  "catalog.archiveVariant": "catalog_archiveVariant",
  "catalog.restoreVariant": "catalog_restoreVariant",
  "pricing.createPriceList": "pricing_createPriceList",
  "pricing.updatePriceList": "pricing_updatePriceList",
  "pricing.activatePriceList": "pricing_activatePriceList",
  "pricing.deactivatePriceList": "pricing_deactivatePriceList",
  "pricing.setDefaultPriceList": "pricing_setDefaultPriceList",
  "pricing.deletePriceList": "pricing_deletePriceList",
  "pricing.setPriceListEntries": "pricing_setPriceListEntries",
  "pricing.removePriceListEntries": "pricing_removePriceListEntries",
  "documents.createFromOrder": "documents_createFromOrder",
  "documents.cancel": "documents_cancel",
  "documents.share": "documents_share",
  "documents.requestSign": "documents_requestSign",
  "invites.create": "invites_create",
  "companies.updateLegal": "companies_updateLegal",
};

export const SHO_740_TOOLS: Readonly<Record<string, string>> = {
  ...SHO_740_READ_TOOLS,
  ...SHO_740_WRITE_TOOLS,
};

export function sho740ToolOf(action: string): string | null {
  return SHO_740_TOOLS[action] ?? null;
}

export function sho740IsWrite(action: string): boolean {
  return SHO_740_WRITE_TOOLS[action] !== undefined;
}

export type Sho740Route =
  "sho_read" | "sho_write_card" | "sho_clarify_card" | "llm";

export interface Sho740Signal {
  readonly tooMany: boolean;
  readonly action: string | null;
  readonly actionConfidence: number;
  readonly marginConfidence: number;
  readonly spanConfidence: number;
  readonly blockingNeeds: number;
}

export const SHO_740_FLOOR = { action: 0.95, margin: 0.4, spans: 0.6 } as const;

function confidentEnough(signal: Sho740Signal, floor: number): boolean {
  return (
    signal.actionConfidence >= floor &&
    signal.marginConfidence >= SHO_740_FLOOR.margin &&
    signal.spanConfidence >= SHO_740_FLOOR.spans
  );
}

export function sho740RouteC(
  signal: Sho740Signal,
  floor: number = SHO_740_FLOOR.action,
): Sho740Route {
  if (signal.tooMany || signal.action === null) {
    return "llm";
  }
  if (sho740ToolOf(signal.action) === null) {
    return "llm";
  }
  if (!confidentEnough(signal, floor)) {
    return "llm";
  }
  if (signal.blockingNeeds > 0) {
    return "sho_clarify_card";
  }
  return sho740IsWrite(signal.action) ? "sho_write_card" : "sho_read";
}

export type Sho740Gate = "command" | "talk" | "mixed" | "unsupported";

export function sho740RouteD(
  gate: Sho740Gate,
  signal: Sho740Signal,
  floor: number = SHO_740_FLOOR.action,
): Sho740Route {
  if (gate !== "command") {
    return "llm";
  }
  return sho740RouteC(signal, floor);
}

export function sho740Shortlist(
  probabilities: readonly number[],
  actions: readonly string[],
  k: number,
  decided: string | null = null,
): readonly string[] {
  const ranked = probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((left, right) => right.probability - left.probability);
  const seed = decided === null ? null : sho740ToolOf(decided);
  const tools: string[] = seed === null ? [] : [seed];
  for (const entry of ranked) {
    const action = actions[entry.index];
    if (action === undefined) {
      continue;
    }
    const tool = sho740ToolOf(action);
    if (tool !== null && !tools.includes(tool)) {
      tools.push(tool);
    }
    if (tools.length === k) {
      break;
    }
  }
  return tools;
}
