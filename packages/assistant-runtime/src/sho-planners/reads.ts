import {
  kyivNamedPeriodRange,
  toProviderToolName,
  CATALOG_GET_PRODUCT_TOOL_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  LIST_ORDERS_QUERY_MAX,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
} from "@showzy/ai";
import { LIST_PRODUCTS_QUERY_MAX } from "@showzy/catalog/contract";
import {
  LIST_CUSTOMERS_SEARCH_MAX,
  LIST_GROUPS_SEARCH_MAX,
} from "@showzy/customers/contract";
import { LIST_PRICE_LISTS_QUERY_MAX } from "@showzy/pricing/contract";
import type { ShoCommand, ShoParam } from "@showzy/sho-protocol";
import { ASSISTANT_SURFACE_REGISTRY } from "@showzy/validation/assistant-surfaces";
import { LIST_COUNTERPARTIES_SEARCH_MAX } from "@showzy/validation/customers";
import { ENTITY_REF_QUERY_MAX } from "@showzy/validation/entity-ref";
import {
  isCanonicalOrderNumberToken,
  SEARCH_ENTITY_TYPES,
  SEARCH_QUERY_MAX,
} from "@showzy/validation/search";

import {
  shoPlanFallback,
  shoRefLocator,
  shoRefused,
  type ShoActionPlan,
  type ShoActionPlanner,
  type ShoActionPlanners,
  type ShoPlanFallbackReason,
} from "./kit.js";

export const SHO_ORDER_STATUSES = [
  "new",
  "confirmed",
  "in_progress",
  "done",
  "canceled",
] as const;

export const SHO_ACTIVE_ORDER_STATUSES = [
  "new",
  "confirmed",
  "in_progress",
] as const;

const RECORD_STATUSES = ["active", "archived", "all"];

const COUNT_GROUPS = ["status", "product", "customer"];

export const SHOZEE_DOCUMENT_TYPES = ["payment_invoice", "delivery_note"];

type Fields = Record<string, unknown>;

type Mapped = Fields | ShoPlanFallbackReason;

type ParamMapper = (param: ShoParam, now: Date) => Mapped;

type ParamMappers = Readonly<Record<string, ParamMapper>>;

const refused = shoRefused;

function enumValue(param: ShoParam): string | null {
  if (Array.isArray(param)) {
    return null;
  }
  if ("value" in param && typeof param.value === "string") {
    return param.value.length > 0 ? param.value : null;
  }
  return "text" in param && param.text.length > 0 ? param.text : null;
}

function spokenText(param: ShoParam): string | null {
  if (Array.isArray(param)) {
    return null;
  }
  const said =
    "value" in param && typeof param.value === "string"
      ? param.value
      : "text" in param
        ? param.text
        : null;
  const text = said?.trim() ?? "";
  return text.length === 0 ? null : text;
}

function clipped(param: ShoParam, max: number): string | null {
  return spokenText(param)?.slice(0, max) ?? null;
}

const locatorOf = shoRefLocator;

const period: ParamMapper = (param, now) => {
  const token = enumValue(param);
  const range = token === null ? null : kyivNamedPeriodRange(token, now);
  return range === null
    ? "unsupported_param"
    : { createdFrom: range.createdFrom, createdTo: range.createdTo };
};

const orderStatus: ParamMapper = (param) => {
  const value = enumValue(param);
  if (value === "active") {
    return { statuses: [...SHO_ACTIVE_ORDER_STATUSES] };
  }
  return value !== null &&
    (SHO_ORDER_STATUSES as readonly string[]).includes(value)
    ? { statuses: [value] }
    : "unsupported_param";
};

const enumField =
  (field: string, allowed: readonly string[]): ParamMapper =>
  (param) => {
    const value = enumValue(param);
    return value !== null && allowed.includes(value)
      ? { [field]: value }
      : "unsupported_param";
  };

const enumList =
  (field: string, allowed: readonly string[]): ParamMapper =>
  (param) => {
    const value = enumValue(param);
    return value !== null && allowed.includes(value)
      ? { [field]: [value] }
      : "unsupported_param";
  };

const recordStatus = enumField("status", RECORD_STATUSES);

const countGroup = enumField("groupBy", COUNT_GROUPS);

const orderCustomer: ParamMapper = (param) => {
  const locator = locatorOf(param);
  if (refused(locator)) {
    return locator;
  }
  return locator.by === "id"
    ? { customerIds: [locator.id] }
    : { query: locator.value.slice(0, LIST_ORDERS_QUERY_MAX) };
};

const orderNumber: ParamMapper = (param) => {
  const text =
    Array.isArray(param) || !("text" in param) ? null : param.text.trim();
  return text === null ||
    text.length === 0 ||
    !isCanonicalOrderNumberToken(text)
    ? "unsupported_param"
    : { query: text.slice(0, LIST_ORDERS_QUERY_MAX) };
};

const refId =
  (field: string): ParamMapper =>
  (param) => {
    const locator = locatorOf(param);
    if (refused(locator)) {
      return locator;
    }
    return locator.by === "id" ? { [field]: locator.id } : "unsupported_param";
  };

const searchText =
  (field: string, max: number): ParamMapper =>
  (param) => {
    const text = clipped(param, max);
    return text === null ? "unsupported_param" : { [field]: text };
  };

const entityRef =
  (idField: string, queryField: string): ParamMapper =>
  (param) => {
    const locator = locatorOf(param);
    if (refused(locator)) {
      return locator;
    }
    return locator.by === "id"
      ? { [idField]: locator.id }
      : { [queryField]: locator.value.slice(0, ENTITY_REF_QUERY_MAX) };
  };

interface ReadPlan {
  readonly toolName: string;
  readonly reply: string;
  readonly params: ParamMappers;
  readonly required?: readonly string[];
  readonly oneOf?: readonly (readonly string[])[];
  readonly defaults?: Fields;
  readonly single?: true;
}

const SURFACED_TOOL_NAMES = new Set<string>(
  ASSISTANT_SURFACE_REGISTRY.flatMap((surface) => [...surface.toolNames]),
);

const SHO_READS: Readonly<Record<string, ReadPlan>> = {
  "orders.list": {
    toolName: ORDERS_LIST_PAGE_TOOL_NAME,
    reply: "Ось замовлення.",
    params: { customer: orderCustomer, status: orderStatus, period },
  },
  "orders.count": {
    toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
    reply: "Ось підсумок.",
    params: {
      customer: orderCustomer,
      status: orderStatus,
      period,
      group_by: countGroup,
    },
    defaults: { groupBy: "status" },
  },
  "orders.get": {
    toolName: ORDERS_LIST_PAGE_TOOL_NAME,
    reply: "Ось замовлення.",
    params: {
      order_number: orderNumber,
      customer: orderCustomer,
      status: orderStatus,
      period,
    },
  },
  "customers.getCustomer": {
    toolName: CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
    reply: "Ось клієнт.",
    params: {
      customer: entityRef("customerId", "customerQuery"),
      phone: searchText("customerQuery", ENTITY_REF_QUERY_MAX),
      email: searchText("customerQuery", ENTITY_REF_QUERY_MAX),
    },
    oneOf: [["customer", "phone", "email"]],
    single: true,
  },
  "customers.listCustomers": {
    toolName: CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    reply: "Ось клієнти.",
    params: {
      search_text: searchText("search", LIST_CUSTOMERS_SEARCH_MAX),
      status: recordStatus,
      group: refId("groupId"),
    },
  },
  "catalog.getProduct": {
    toolName: CATALOG_GET_PRODUCT_TOOL_NAME,
    reply: "Ось товар.",
    params: { product: entityRef("productId", "productQuery") },
    required: ["product"],
    single: true,
  },
  "catalog.listProducts": {
    toolName: CATALOG_LIST_PRODUCTS_TOOL_NAME,
    reply: "Ось товари.",
    params: {
      search_text: searchText("query", LIST_PRODUCTS_QUERY_MAX),
      status: recordStatus,
    },
  },
  "customers.listGroups": {
    toolName: CUSTOMERS_LIST_GROUPS_TOOL_NAME,
    reply: "Ось групи.",
    params: { search_text: searchText("search", LIST_GROUPS_SEARCH_MAX) },
  },
  "customers.getGroup": {
    toolName: toProviderToolName("customers.getGroup"),
    reply: "Ось група.",
    params: { group: refId("id") },
    required: ["group"],
    single: true,
  },
  "customers.listCounterparties": {
    toolName: toProviderToolName("customers.listCounterparties"),
    reply: "Ось контрагенти.",
    params: {
      search_text: searchText("search", LIST_COUNTERPARTIES_SEARCH_MAX),
      customer: refId("customerId"),
    },
  },
  "customers.getCounterparty": {
    toolName: toProviderToolName("customers.getCounterparty"),
    reply: "Ось контрагент.",
    params: { counterparty: refId("id") },
    required: ["counterparty"],
    single: true,
  },
  "pricing.listPriceLists": {
    toolName: PRICING_LIST_PRICE_LISTS_TOOL_NAME,
    reply: "Ось прайс-листи.",
    params: { search_text: searchText("query", LIST_PRICE_LISTS_QUERY_MAX) },
  },
  "pricing.getPriceList": {
    toolName: toProviderToolName("pricing.getPriceList"),
    reply: "Ось прайс-лист.",
    params: { price_list: refId("id") },
    required: ["price_list"],
    single: true,
  },
  "pricing.listPriceListEntries": {
    toolName: toProviderToolName("pricing.listPriceListEntries"),
    reply: "Ось ціни прайс-листа.",
    params: {
      price_list: refId("priceListId"),
      product: refId("productId"),
    },
    required: ["price_list"],
  },
  "documents.list": {
    toolName: toProviderToolName("documents.list"),
    reply: "Ось документи.",
    params: { document_type: enumField("type", SHOZEE_DOCUMENT_TYPES) },
  },
  "docGeneration.listLayouts": {
    toolName: toProviderToolName("docGeneration.listLayouts"),
    reply: "Ось шаблони документів.",
    params: { document_type: enumField("type", SHOZEE_DOCUMENT_TYPES) },
  },
  "search.query": {
    toolName: toProviderToolName("search.query"),
    reply: "Ось що знайшлося.",
    params: {
      search_text: searchText("query", SEARCH_QUERY_MAX),
      search_type: enumList("types", SEARCH_ENTITY_TYPES),
    },
    required: ["search_text"],
  },
};

export const SHO_READ_ACTIONS: readonly string[] = Object.freeze(
  Object.keys(SHO_READS),
);

export const SHO_READ_TOOL_NAMES: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(SHO_READS).map(([action, read]) => [
        action,
        read.toolName,
      ]),
    ),
  );

export const SHO_SURFACED_READ_ACTIONS: readonly string[] = Object.freeze(
  Object.entries(SHO_READS)
    .filter(([, read]) => SURFACED_TOOL_NAMES.has(read.toolName))
    .map(([action]) => action),
);

export const SHO_READ_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(SHO_READS).map(([action, read]) => [
      action,
      Object.freeze(Object.keys(read.params)),
    ]),
  ),
);

function inputFor(
  read: ReadPlan,
  command: ShoCommand,
  now: Date,
): Fields | ShoPlanFallbackReason {
  const said = Object.entries(command.params);
  if (read.single === true && said.length > 1) {
    return "unsupported_param";
  }
  const input: Record<string, unknown> = {};
  for (const [name, param] of said) {
    const mapper = read.params[name];
    if (mapper === undefined) {
      return "unsupported_param";
    }
    const mapped = mapper(param, now);
    if (refused(mapped)) {
      return mapped;
    }
    for (const [field, value] of Object.entries(mapped)) {
      if (field in input) {
        return "unsupported_param";
      }
      input[field] = value;
    }
  }
  const spoken = (name: string): boolean => Object.hasOwn(command.params, name);
  if (
    !(read.required ?? []).every(spoken) ||
    !(read.oneOf ?? []).every((names) => names.some(spoken))
  ) {
    return "unsupported_param";
  }
  return { ...read.defaults, ...input };
}

function plannerFor(
  read: ReadPlan,
  surfaced: ReadonlySet<string>,
): ShoActionPlanner {
  const hasSurface = surfaced.has(read.toolName);
  return {
    writes: false,
    plan: (command: ShoCommand, now: Date): ShoActionPlan => {
      const input = inputFor(read, command, now);
      if (refused(input)) {
        return shoPlanFallback(input);
      }
      return hasSurface
        ? {
            kind: "call",
            toolName: read.toolName,
            input,
            reply: read.reply,
          }
        : shoPlanFallback("no_surface");
    },
  };
}

export const shoReadPlanners = (
  surfaced: ReadonlySet<string>,
): ShoActionPlanners =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(SHO_READS).map(([action, read]) => [
        action,
        plannerFor(read, surfaced),
      ]),
    ),
  );

export const SHO_READ_PLANNERS: ShoActionPlanners =
  shoReadPlanners(SURFACED_TOOL_NAMES);
