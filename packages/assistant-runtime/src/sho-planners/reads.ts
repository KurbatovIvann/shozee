import {
  kyivNamedPeriodRange,
  toProviderToolName,
  CATALOG_GET_PRODUCT_TOOL_NAME,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
} from "@showzy/ai";
import type { ShoCommand, ShoParam, ShoRef } from "@showzy/sho-protocol";

import type { ShoPlan } from "../sho-turn.js";

import {
  shoLocatorFor,
  shoPlanFallback,
  type ShoActionPlanner,
  type ShoActionPlanners,
  type ShoLocator,
} from "./kit.js";

const ORDERS_GET_ACTION = "orders.get";

export const ORDERS_GET_TOOL_NAME = toProviderToolName(ORDERS_GET_ACTION);

export const SHO_ORDER_STATUSES = [
  "new",
  "confirmed",
  "in_progress",
  "done",
  "canceled",
] as const;

export const SHO_ORDER_STATUSES_MAX = 5;

const SHO_READ_REPLIES = {
  "orders.list": "Ось замовлення.",
  "orders.count": "Ось підсумок.",
  "orders.get": "Ось замовлення.",
  "customers.getCustomer": "Ось клієнт.",
  "customers.listCustomers": "Ось клієнти.",
  "catalog.getProduct": "Ось товар.",
  "catalog.listProducts": "Ось товари.",
  "pricing.listPriceLists": "Ось прайс-листи.",
} as const;

type ShoReadAction = keyof typeof SHO_READ_REPLIES;

export const SHO_READ_ACTIONS: readonly string[] = Object.freeze(
  Object.keys(SHO_READ_REPLIES),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReadInput = Record<string, unknown>;

type Mapped = { readonly input: ReadInput } | { readonly fallback: ShoPlan };

const unsupportedParam = (): Mapped => ({
  fallback: shoPlanFallback("unsupported_param"),
});

function isRef(param: ShoParam | undefined): param is ShoRef {
  return (
    param !== undefined &&
    !Array.isArray(param) &&
    "status" in param &&
    !("attrs" in param)
  );
}

function enumValue(param: ShoParam | undefined): string | null {
  if (param === undefined || Array.isArray(param)) {
    return null;
  }
  if ("value" in param && typeof param.value === "string") {
    return param.value.length > 0 ? param.value : null;
  }
  return "text" in param && param.text.length > 0 ? param.text : null;
}

function spanText(param: ShoParam | undefined): string | null {
  if (param === undefined || Array.isArray(param) || !("text" in param)) {
    return null;
  }
  const text = param.text.trim();
  return text.length > 0 ? text : null;
}

function statusList(param: ShoParam | undefined): readonly string[] | null {
  const said = Array.isArray(param)
    ? param.map((entry) => (typeof entry === "string" ? entry : null))
    : [enumValue(param)];
  const statuses = said.filter((value): value is string => value !== null);
  if (statuses.length !== said.length || statuses.length === 0) {
    return null;
  }
  const known = (SHO_ORDER_STATUSES as readonly string[]).filter((status) =>
    statuses.includes(status),
  );
  return known.length === new Set(statuses).size &&
    known.length <= SHO_ORDER_STATUSES_MAX
    ? known
    : null;
}

function onlyKnownParams(
  command: ShoCommand,
  supported: readonly string[],
): boolean {
  return Object.keys(command.params).every((name) => supported.includes(name));
}

function locatorOf(param: ShoParam | undefined): ShoLocator | ShoPlan {
  if (!isRef(param)) {
    return shoPlanFallback("unsupported_param");
  }
  const outcome = shoLocatorFor(param);
  return outcome.kind === "locator"
    ? outcome.locator
    : shoPlanFallback(outcome.reason);
}

const isPlan = (value: ShoLocator | ShoPlan): value is ShoPlan =>
  "kind" in value;

function withPeriod(command: ShoCommand, now: Date, input: ReadInput): Mapped {
  const said = command.params["period"];
  if (said === undefined) {
    return { input };
  }
  const period = enumValue(said);
  const range = period === null ? null : kyivNamedPeriodRange(period, now);
  return range === null
    ? unsupportedParam()
    : {
        input: {
          ...input,
          createdFrom: range.createdFrom,
          createdTo: range.createdTo,
        },
      };
}

function withStatuses(command: ShoCommand, input: ReadInput): Mapped {
  const said = command.params["status"];
  if (said === undefined) {
    return { input };
  }
  const statuses = statusList(said);
  return statuses === null
    ? unsupportedParam()
    : { input: { ...input, statuses } };
}

function withCustomer(command: ShoCommand, input: ReadInput): Mapped {
  const said = command.params["customer"];
  if (said === undefined) {
    return { input };
  }
  const locator = locatorOf(said);
  if (isPlan(locator)) {
    return { fallback: locator };
  }
  return {
    input:
      locator.by === "id"
        ? { ...input, customerIds: [locator.id] }
        : { ...input, query: locator.value },
  };
}

function ordersFilter(command: ShoCommand, now: Date, base: ReadInput): Mapped {
  const period = withPeriod(command, now, base);
  if ("fallback" in period) {
    return period;
  }
  const statuses = withStatuses(command, period.input);
  if ("fallback" in statuses) {
    return statuses;
  }
  return withCustomer(command, statuses.input);
}

function call(action: ShoReadAction, toolName: string, input: ReadInput) {
  return {
    kind: "call" as const,
    toolName,
    input,
    reply: SHO_READ_REPLIES[action],
  };
}

function settled(
  action: ShoReadAction,
  toolName: string,
  mapped: Mapped,
): ShoPlan {
  return "fallback" in mapped
    ? mapped.fallback
    : call(action, toolName, mapped.input);
}

const ORDERS_FILTER_PARAMS = ["period", "status", "customer"];

function planOrdersList(command: ShoCommand, now: Date): ShoPlan {
  return onlyKnownParams(command, ORDERS_FILTER_PARAMS)
    ? settled(
        "orders.list",
        ORDERS_LIST_PAGE_TOOL_NAME,
        ordersFilter(command, now, {}),
      )
    : shoPlanFallback("unsupported_param");
}

function planOrdersCount(command: ShoCommand, now: Date): ShoPlan {
  return onlyKnownParams(command, ORDERS_FILTER_PARAMS)
    ? settled(
        "orders.count",
        ORDERS_LIST_COUNTS_TOOL_NAME,
        ordersFilter(command, now, { groupBy: "status" }),
      )
    : shoPlanFallback("unsupported_param");
}

function planOrdersGet(command: ShoCommand): ShoPlan {
  if (!onlyKnownParams(command, ["order"])) {
    return shoPlanFallback("unsupported_param");
  }
  const locator = locatorOf(command.params["order"]);
  if (isPlan(locator)) {
    return locator;
  }
  return locator.by === "id" && UUID.test(locator.id)
    ? call("orders.get", ORDERS_GET_TOOL_NAME, { orderId: locator.id })
    : shoPlanFallback("unsupported_param");
}

function planEntityCard(
  action: ShoReadAction,
  toolName: string,
  paramName: string,
  idField: string,
  queryField: string,
): (command: ShoCommand) => ShoPlan {
  return (command) => {
    if (!onlyKnownParams(command, [paramName])) {
      return shoPlanFallback("unsupported_param");
    }
    const locator = locatorOf(command.params[paramName]);
    if (isPlan(locator)) {
      return locator;
    }
    return locator.by === "id"
      ? call(action, toolName, { [idField]: locator.id })
      : call(action, toolName, { [queryField]: locator.value });
  };
}

function planNamedList(
  action: ShoReadAction,
  toolName: string,
  queryField: string,
  refParam: string,
): (command: ShoCommand) => ShoPlan {
  return (command) => {
    if (!onlyKnownParams(command, ["query", refParam])) {
      return shoPlanFallback("unsupported_param");
    }
    const said = command.params["query"] ?? command.params[refParam];
    if (said === undefined) {
      return call(action, toolName, {});
    }
    const query = isRef(said) ? said.text.trim() : spanText(said);
    return query === null || query.length === 0
      ? shoPlanFallback("unsupported_param")
      : call(action, toolName, { [queryField]: query });
  };
}

const read = (plan: ShoActionPlanner["plan"]): ShoActionPlanner => ({
  writes: false,
  plan,
});

export const SHO_READ_PLANNERS: ShoActionPlanners = {
  "orders.list": read(planOrdersList),
  "orders.count": read(planOrdersCount),
  "orders.get": read(planOrdersGet),
  "customers.getCustomer": read(
    planEntityCard(
      "customers.getCustomer",
      CUSTOMERS_GET_CUSTOMER_TOOL_NAME,
      "customer",
      "customerId",
      "customerQuery",
    ),
  ),
  "customers.listCustomers": read(
    planNamedList(
      "customers.listCustomers",
      CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
      "search",
      "customer",
    ),
  ),
  "catalog.getProduct": read(
    planEntityCard(
      "catalog.getProduct",
      CATALOG_GET_PRODUCT_TOOL_NAME,
      "product",
      "productId",
      "productQuery",
    ),
  ),
  "catalog.listProducts": read(
    planNamedList(
      "catalog.listProducts",
      CATALOG_LIST_PRODUCTS_TOOL_NAME,
      "query",
      "product",
    ),
  ),
  "pricing.listPriceLists": read(
    planNamedList(
      "pricing.listPriceLists",
      PRICING_LIST_PRICE_LISTS_TOOL_NAME,
      "query",
      "price_list",
    ),
  ),
};
