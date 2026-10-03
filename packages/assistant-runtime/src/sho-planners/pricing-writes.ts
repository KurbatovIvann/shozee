import { toProviderToolName } from "@showzy/ai";
import { PRICE_LIST_NAME_MAX } from "@showzy/pricing/contract";

import type { ShoActionPlanners } from "./kit.js";
import {
  shoCreatedName,
  shoIdOnly,
  shoRenamedName,
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
