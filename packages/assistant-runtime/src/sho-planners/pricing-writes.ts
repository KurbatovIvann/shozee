import { toProviderToolName } from "@showzy/ai";
import {
  DEFAULT_PRICE_CURRENCY,
  PRICE_LIST_NAME_MAX,
  REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS,
  SET_PRICE_LIST_ENTRIES_MAX_ITEMS,
} from "@showzy/pricing/contract";
import type { ShoParam } from "@showzy/sho-protocol";

import {
  shoIsRef,
  shoRefused,
  SHO_UUID,
  type ShoActionPlanners,
  type ShoPlanFallbackReason,
} from "./kit.js";
import {
  shoCreatedName,
  shoIdFrom,
  shoIdOnly,
  shoMoneyOf,
  shoRenamedName,
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteFields,
  type ShoWriteMapped,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_PRICE_LIST = "pricing.createPriceList";

export const SHO_UPDATE_PRICE_LIST = "pricing.updatePriceList";

export const SHO_ACTIVATE_PRICE_LIST = "pricing.activatePriceList";

export const SHO_DEACTIVATE_PRICE_LIST = "pricing.deactivatePriceList";

export const SHO_SET_DEFAULT_PRICE_LIST = "pricing.setDefaultPriceList";

export const SHO_CLEAR_DEFAULT_PRICE_LIST = "pricing.clearDefaultPriceList";

export const SHO_DELETE_PRICE_LIST = "pricing.deletePriceList";

export const SHO_SET_PRICE_LIST_ENTRIES = "pricing.setPriceListEntries";

export const SHO_REMOVE_PRICE_LIST_ENTRIES = "pricing.removePriceListEntries";

export const SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY =
  "Прайс-лист за замовчуванням знято.";

export const SHO_READ_AS_FOCUS_PRICE_LIST_NOTE =
  "Прочитано як дію над прайс-листом з розмови";

const FOCUS_PRICE_LIST_NOTES: Readonly<Record<string, string>> = {
  read_as_focus_type: SHO_READ_AS_FOCUS_PRICE_LIST_NOTE,
};

const createdName = shoCreatedName("price_list", PRICE_LIST_NAME_MAX);

const renamedTo = shoRenamedName(PRICE_LIST_NAME_MAX);

const flag =
  (field: string): ShoWriteParamMapper =>
  (param) => {
    const value = shoSpokenText(param);
    if (value !== "true" && value !== "false") {
      return "unsupported_param";
    }
    return { [field]: value === "true" };
  };

const onPriceList = (
  action: string,
  reply: string,
  field: string,
): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { price_list: shoIdOnly(field) },
  required: ["price_list"],
  notes: FOCUS_PRICE_LIST_NOTES,
});

function productLines(
  param: ShoParam,
  max: number,
): readonly ShoWriteFields[] | ShoPlanFallbackReason {
  const said: readonly unknown[] = Array.isArray(param) ? param : [param];
  if (said.length === 0 || said.length > max) {
    return "unsupported_param";
  }
  const lines: ShoWriteFields[] = [];
  for (const entry of said) {
    if (!shoIsRef(entry)) {
      return "unsupported_param";
    }
    const mapped = shoIdFrom(entry, "productId");
    if (shoRefused(mapped)) {
      return mapped;
    }
    lines.push(mapped);
  }
  return lines;
}

function variantOfLine(param: ShoParam | undefined): ShoWriteMapped {
  if (param === undefined) {
    return {};
  }
  if (Array.isArray(param) || !("attrs" in param)) {
    return "unsupported_param";
  }
  if (param.status === "none" || param.status === "unspecified") {
    return {};
  }
  const id = param.id;
  return param.status === "resolved" &&
    typeof id === "string" &&
    SHO_UUID.test(id)
    ? { variantId: id }
    : "unsupported_param";
}

function priceOfLine(param: ShoParam | undefined): ShoWriteMapped {
  if (param === undefined) {
    return {};
  }
  const money = shoMoneyOf(param);
  return money === null || money.currency !== DEFAULT_PRICE_CURRENCY
    ? "unsupported_param"
    : { priceMinor: String(money.minor), currency: DEFAULT_PRICE_CURRENCY };
}

const entriesFromProducts =
  (max: number, priced: boolean): ShoWriteParamMapper =>
  (param, command) => {
    const lines = productLines(param, max);
    if (shoRefused(lines)) {
      return lines;
    }
    const variant = variantOfLine(command.params["variant"]);
    if (shoRefused(variant)) {
      return variant;
    }
    const price = priced ? priceOfLine(command.params["price"]) : {};
    if (shoRefused(price)) {
      return price;
    }
    if (lines.length > 1 && Object.hasOwn(variant, "variantId")) {
      return "unsupported_param";
    }
    return {
      entries: lines.map((line) => ({ ...line, ...variant, ...price })),
    };
  };

const mappedWithTheProduct: ShoWriteParamMapper = () => ({});

const SHO_PRICING_WRITES: ShoWritePlans = {
  [SHO_CREATE_PRICE_LIST]: {
    toolName: toProviderToolName(SHO_CREATE_PRICE_LIST),
    reply: "Прайс-лист створено.",
    params: {
      new_name: createdName,
      is_default: flag("isDefault"),
      is_active: flag("isActive"),
    },
    required: ["new_name"],
  },
  [SHO_UPDATE_PRICE_LIST]: {
    toolName: toProviderToolName(SHO_UPDATE_PRICE_LIST),
    reply: "Прайс-лист оновлено.",
    params: {
      price_list: shoIdOnly("id"),
      rename_to: renamedTo,
    },
    required: ["price_list"],
    oneOf: [["rename_to"]],
    notes: FOCUS_PRICE_LIST_NOTES,
  },
  [SHO_ACTIVATE_PRICE_LIST]: onPriceList(
    SHO_ACTIVATE_PRICE_LIST,
    "Прайс-лист активовано.",
    "id",
  ),
  [SHO_DEACTIVATE_PRICE_LIST]: onPriceList(
    SHO_DEACTIVATE_PRICE_LIST,
    "Прайс-лист деактивовано.",
    "id",
  ),
  [SHO_SET_DEFAULT_PRICE_LIST]: onPriceList(
    SHO_SET_DEFAULT_PRICE_LIST,
    "Прайс-лист призначено основним.",
    "priceListId",
  ),
  [SHO_DELETE_PRICE_LIST]: onPriceList(
    SHO_DELETE_PRICE_LIST,
    "Прайс-лист видалено.",
    "id",
  ),
  [SHO_SET_PRICE_LIST_ENTRIES]: {
    toolName: toProviderToolName(SHO_SET_PRICE_LIST_ENTRIES),
    reply: "Ціни в прайс-листі оновлено.",
    params: {
      price_list: shoIdOnly("priceListId"),
      product: entriesFromProducts(SET_PRICE_LIST_ENTRIES_MAX_ITEMS, true),
      variant: mappedWithTheProduct,
      price: mappedWithTheProduct,
    },
    required: ["price_list", "product", "price"],
    notes: FOCUS_PRICE_LIST_NOTES,
  },
  [SHO_REMOVE_PRICE_LIST_ENTRIES]: {
    toolName: toProviderToolName(SHO_REMOVE_PRICE_LIST_ENTRIES),
    reply: "Ціни з прайс-листа прибрано.",
    params: {
      price_list: shoIdOnly("priceListId"),
      product: entriesFromProducts(REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS, false),
      variant: mappedWithTheProduct,
    },
    required: ["price_list", "product"],
    notes: FOCUS_PRICE_LIST_NOTES,
  },
  [SHO_CLEAR_DEFAULT_PRICE_LIST]: {
    toolName: toProviderToolName(SHO_SET_DEFAULT_PRICE_LIST),
    reply: SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY,
    params: {},
    constants: { priceListId: null },
    required: [],
  },
};

export const SHO_PRICING_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_PRICING_WRITES);

export const SHO_PRICING_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_PRICING_WRITES);

export const SHO_PRICING_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_PRICING_WRITES);
