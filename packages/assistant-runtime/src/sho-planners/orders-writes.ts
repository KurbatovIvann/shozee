import {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
  ORDERS_CREATE_QUERY_MAX,
  ORDERS_CREATE_TOOL_NAME,
} from "@showzy/ai";
import type {
  ShoAttr,
  ShoOrderItem,
  ShoParam,
  ShoQuantity,
  ShoVariantRef,
} from "@showzy/sho-protocol";

import {
  shoIsRef,
  shoRefLocator,
  shoRefused,
  SHO_UUID,
  type ShoActionPlanners,
  type ShoLocator,
  type ShoPlanFallbackReason,
} from "./kit.js";
import {
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteFields as Fields,
  type ShoWriteMapped as Mapped,
  type ShoWriteParamMapper,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_READ_AS_CREATE_NOTE = "Прочитано як нове замовлення";

const QUANTITY_MILLI_SCALE = 1000;

const QUANTITY_MILLI_EPSILON = 1e-6;

const refused = shoRefused;

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

const COUNTING_UNITS: readonly string[] = ["pcs", "pair", "bottle", "can"];

function quantityFields(quantity: ShoQuantity): Mapped {
  if (quantity.unit !== null && !COUNTING_UNITS.includes(quantity.unit)) {
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

const createComment: ShoWriteParamMapper = (param) => {
  const text = shoSpokenText(param);
  return text === null
    ? "unsupported_param"
    : { comment: text.slice(0, CREATE_ORDER_COMMENT_MAX) };
};

const SHO_ORDER_WRITES: ShoWritePlans = {
  "orders.create": {
    toolName: ORDERS_CREATE_TOOL_NAME,
    reply: "Замовлення створено.",
    params: {
      customer: createCustomer,
      items: createItems,
      comment: createComment,
    },
    required: ["customer", "items"],
    notes: { read_as_create: SHO_READ_AS_CREATE_NOTE },
  },
};

export const SHO_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_ORDER_WRITES);

export const SHO_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_ORDER_WRITES);

export const SHO_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_ORDER_WRITES);
