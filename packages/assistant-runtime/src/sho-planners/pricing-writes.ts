import { toProviderToolName } from "@showzy/ai";
import { PRICE_LIST_NAME_MAX } from "@showzy/pricing/contract";
import type { ShoParam } from "@showzy/sho-protocol";

import {
  shoPlanFallback,
  type ShoActionPlan,
  type ShoActionPlanner,
  type ShoActionPlanners,
} from "./kit.js";
import {
  shoIdOnly,
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
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

export const SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY =
  "Прайс-лист за замовчуванням знято.";

export const SHO_READ_AS_FOCUS_PRICE_LIST_NOTE =
  "Прочитано як дію над прайс-листом з розмови";

const FOCUS_PRICE_LIST_NOTES: Readonly<Record<string, string>> = {
  read_as_focus_type: SHO_READ_AS_FOCUS_PRICE_LIST_NOTE,
};

const clipped = (param: ShoParam): string | null =>
  shoSpokenText(param)?.slice(0, PRICE_LIST_NAME_MAX) ?? null;

const createdName: ShoWriteParamMapper = (param, command) => {
  const nominative =
    command.creates?.type === "price_list"
      ? (command.creates.name ?? "").trim()
      : "";
  const text =
    nominative.length > 0
      ? nominative.slice(0, PRICE_LIST_NAME_MAX)
      : clipped(param);
  return text === null ? "unsupported_param" : { name: text };
};

const renamedTo: ShoWriteParamMapper = (param) => {
  const text = clipped(param);
  return text === null ? "unsupported_param" : { name: text };
};

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
};

const clearsDefault: ShoActionPlanner = {
  writes: true,
  plan: (command): ShoActionPlan =>
    Object.keys(command.params).length > 0
      ? shoPlanFallback("unsupported_param")
      : {
          kind: "call",
          toolName: toProviderToolName(SHO_SET_DEFAULT_PRICE_LIST),
          input: { priceListId: null },
          reply: SHO_DEFAULT_PRICE_LIST_CLEARED_REPLY,
        },
};

export const SHO_PRICING_WRITE_ACTIONS: readonly string[] = Object.freeze([
  ...shoWriteActions(SHO_PRICING_WRITES),
  SHO_CLEAR_DEFAULT_PRICE_LIST,
]);

export const SHO_PRICING_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  ...shoWritePlannerParams(SHO_PRICING_WRITES),
  [SHO_CLEAR_DEFAULT_PRICE_LIST]: Object.freeze([] as readonly string[]),
});

export const SHO_PRICING_WRITE_PLANNERS: ShoActionPlanners = Object.freeze({
  ...shoWritePlanners(SHO_PRICING_WRITES),
  [SHO_CLEAR_DEFAULT_PRICE_LIST]: clearsDefault,
});
