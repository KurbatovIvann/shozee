import {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
  ORDERS_CREATE_QUERY_MAX,
  ORDERS_CREATE_TOOL_NAME,
} from "@showzy/ai";
import type {
  ShoAttr,
  ShoCommand,
  ShoNeed,
  ShoOrderItem,
  ShoParam,
  ShoQuantity,
  ShoVariantRef,
} from "@showzy/sho-protocol";

import type { ShoPlan } from "../sho-turn.js";

import {
  shoIsRef,
  shoPlanFallback,
  shoRefLocator,
  shoRefused,
  SHO_UUID,
  type ShoActionPlanner,
  type ShoActionPlanners,
  type ShoLocator,
  type ShoPlanFallbackReason,
} from "./kit.js";

export const SHO_READ_AS_CREATE_NOTE = "Прочитано як нове замовлення";

const QUANTITY_MILLI_SCALE = 1000;

const QUANTITY_MILLI_EPSILON = 1e-6;

type Fields = Record<string, unknown>;

type Mapped = Fields | ShoPlanFallbackReason;

const refused = shoRefused;

function spokenText(param: ShoParam): string | null {
  if (Array.isArray(param) || !("text" in param)) {
    return null;
  }
  const text = param.text.trim();
  return text.length === 0 ? null : text;
}

function uncheckedName(param: ShoParam): ShoLocator | null {
  if (!shoIsRef(param) || param.status !== "unchecked") {
    return null;
  }
  const said = param.text.trim();
  return said.length === 0 ? null : { by: "query", value: said };
}

function writeLocator(param: ShoParam): ShoLocator | ShoPlanFallbackReason {
  const locator = shoRefLocator(param);
  if (!refused(locator) || locator !== "unresolved_reference") {
    return locator;
  }
  return uncheckedName(param) ?? locator;
}

function isOrderItems(param: ShoParam): param is ShoOrderItem[] {
  return (
    Array.isArray(param) &&
    param.every(
      (entry) =>
        typeof entry === "object" &&
        "product" in entry &&
        "quantity" in entry &&
        "variant" in entry,
    )
  );
}

const MEASURED_UNITS: readonly string[] = ["g", "kg", "t", "ml", "l"];

function quantityFields(quantity: ShoQuantity): Mapped {
  if (quantity.unit !== null && MEASURED_UNITS.includes(quantity.unit)) {
    return "unsupported_param";
  }
  const said = quantity.value;
  if (said === null || !Number.isFinite(said) || said <= 0) {
    return "unsupported_param";
  }
  const scaled = said * QUANTITY_MILLI_SCALE;
  const milli = Math.round(scaled);
  return milli <= 0 || Math.abs(scaled - milli) > QUANTITY_MILLI_EPSILON
    ? "unsupported_param"
    : { quantityMilli: String(milli) };
}

function attrQuery(attrs: readonly ShoAttr[]): string | null {
  const said = attrs
    .map((attr) => attr.text.trim())
    .filter((text) => text.length > 0)
    .join(" ");
  return said.length === 0 ? null : said.slice(0, ORDERS_CREATE_QUERY_MAX);
}

function variantFields(
  variant: ShoVariantRef,
  attrs: readonly ShoAttr[],
): Mapped {
  if (variant.status === "resolved") {
    return typeof variant.id === "string" && SHO_UUID.test(variant.id)
      ? { variantId: variant.id }
      : "unsupported_param";
  }
  if (variant.status === "none" || variant.status === "unspecified") {
    return {};
  }
  if (
    variant.status === "unchecked" ||
    variant.status === "ambiguous" ||
    variant.status === "unknown"
  ) {
    const query = attrQuery(attrs);
    return query === null ? {} : { variantQuery: query };
  }
  return "unsupported_param";
}

function itemFields(item: ShoOrderItem): Mapped {
  const product = writeLocator(item.product);
  if (refused(product)) {
    return product;
  }
  const quantity = quantityFields(item.quantity);
  if (refused(quantity)) {
    return quantity;
  }
  const variant = variantFields(item.variant, item.attrs);
  if (refused(variant)) {
    return variant;
  }
  return {
    ...(product.by === "id"
      ? { productId: product.id }
      : { productQuery: product.value.slice(0, ORDERS_CREATE_QUERY_MAX) }),
    ...variant,
    ...quantity,
  };
}

const createCustomer = (param: ShoParam): Mapped => {
  const locator = writeLocator(param);
  if (refused(locator)) {
    return locator;
  }
  return locator.by === "id"
    ? { customerId: locator.id }
    : { customerQuery: locator.value.slice(0, ORDERS_CREATE_QUERY_MAX) };
};

const createItems = (param: ShoParam): Mapped => {
  if (!isOrderItems(param)) {
    return "unsupported_param";
  }
  if (param.length === 0 || param.length > CREATE_ORDER_MAX_ITEMS) {
    return "unsupported_param";
  }
  const items: Fields[] = [];
  for (const item of param) {
    const mapped = itemFields(item);
    if (refused(mapped)) {
      return mapped;
    }
    items.push(mapped);
  }
  return { items };
};

const createComment = (param: ShoParam): Mapped => {
  const text = spokenText(param);
  return text === null
    ? "unsupported_param"
    : { comment: text.slice(0, CREATE_ORDER_COMMENT_MAX) };
};

type ParamMapper = (param: ShoParam) => Mapped;

interface WritePlan {
  readonly toolName: string;
  readonly reply: string;
  readonly params: Readonly<Record<string, ParamMapper>>;
  readonly required: readonly string[];
}

const SHO_ORDER_WRITES: Readonly<Record<string, WritePlan>> = {
  "orders.create": {
    toolName: ORDERS_CREATE_TOOL_NAME,
    reply: "Замовлення створено.",
    params: {
      customer: createCustomer,
      items: createItems,
      comment: createComment,
    },
    required: ["customer", "items"],
  },
};

export const SHO_WRITE_ACTIONS: readonly string[] = Object.freeze(
  Object.keys(SHO_ORDER_WRITES),
);

export const SHO_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(SHO_ORDER_WRITES).map(([action, write]) => [
      action,
      Object.freeze(Object.keys(write.params)),
    ]),
  ),
);

function noteOf(need: ShoNeed): string {
  const span = need.span?.text.trim() ?? "";
  return span.length === 0
    ? `${SHO_READ_AS_CREATE_NOTE}.`
    : `${SHO_READ_AS_CREATE_NOTE}: «${span}».`;
}

export function shoWriteNotes(command: ShoCommand): readonly string[] {
  return command.needs
    .filter((need) => !need.blocking && need.reason === "read_as_create")
    .map((need) => noteOf(need));
}

function inputFor(write: WritePlan, command: ShoCommand): Mapped {
  const input: Fields = {};
  for (const [name, param] of Object.entries(command.params)) {
    const mapper = write.params[name];
    if (mapper === undefined) {
      return "unsupported_param";
    }
    const mapped = mapper(param);
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
  return write.required.every((name) => name in command.params)
    ? input
    : "blocking_need";
}

function plannerFor(write: WritePlan): ShoActionPlanner {
  return {
    writes: true,
    plan: (command): ShoPlan => {
      const input = inputFor(write, command);
      if (refused(input)) {
        return shoPlanFallback(input);
      }
      const notes = shoWriteNotes(command);
      return {
        kind: "call",
        writes: true,
        toolName: write.toolName,
        input,
        reply: write.reply,
        ...(notes.length === 0 ? {} : { notes }),
      };
    },
  };
}

export const SHO_WRITE_PLANNERS: ShoActionPlanners = Object.freeze(
  Object.fromEntries(
    Object.entries(SHO_ORDER_WRITES).map(([action, write]) => [
      action,
      plannerFor(write),
    ]),
  ),
);
