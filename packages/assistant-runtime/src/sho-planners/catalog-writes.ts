import { toProviderToolName } from "@showzy/ai";
import type { ShoParam } from "@showzy/sho-protocol";
import {
  DEFAULT_PRODUCT_CURRENCY,
  PRODUCT_NAME_MAX,
} from "@showzy/validation/catalog";

import { shoRefLocator, shoRefused, type ShoActionPlanners } from "./kit.js";
import {
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteMapped,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_PRODUCT = "catalog.createProduct";

export const SHO_UPDATE_PRODUCT = "catalog.updateProduct";

export const SHO_ARCHIVE_PRODUCT = "catalog.archiveProduct";

export const SHO_RESTORE_PRODUCT = "catalog.restoreProduct";

export const SHO_READ_AS_PRODUCT_UPDATE_NOTE =
  "Прочитано як редагування товару, не створення";

export const SHO_READ_AS_FOCUS_PRODUCT_NOTE =
  "Прочитано як дію над товаром з розмови";

const FOCUS_NOTES: Readonly<Record<string, string>> = {
  read_as_focus_type: SHO_READ_AS_FOCUS_PRODUCT_NOTE,
};

const UPDATE_NOTES: Readonly<Record<string, string>> = {
  ...FOCUS_NOTES,
  read_as_update: SHO_READ_AS_PRODUCT_UPDATE_NOTE,
};

interface ShoMoney {
  readonly minor: number;
  readonly currency: string;
}

const moneyOf = (param: ShoParam): ShoMoney | null => {
  if (Array.isArray(param) || !("value" in param)) {
    return null;
  }
  const value: unknown = param.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !("minor" in value) ||
    !("currency" in value)
  ) {
    return null;
  }
  const minor: unknown = value.minor;
  const currency: unknown = value.currency;
  return typeof minor === "number" &&
    Number.isSafeInteger(minor) &&
    minor >= 0 &&
    typeof currency === "string"
    ? { minor, currency }
    : null;
};

const basePrice: ShoWriteParamMapper = (param) => {
  const money = moneyOf(param);
  return money === null || money.currency !== DEFAULT_PRODUCT_CURRENCY
    ? "unsupported_param"
    : {
        basePriceMinor: String(money.minor),
        currency: DEFAULT_PRODUCT_CURRENCY,
      };
};

const productId: ShoWriteParamMapper = (param): ShoWriteMapped => {
  const locator = shoRefLocator(param);
  if (shoRefused(locator)) {
    return locator;
  }
  return locator.by === "id" ? { productId: locator.id } : "unsupported_param";
};

const named = (param: ShoParam): string | null =>
  shoSpokenText(param)?.slice(0, PRODUCT_NAME_MAX) ?? null;

const createdName: ShoWriteParamMapper = (param, command) => {
  const nominative =
    command.creates?.type === "product"
      ? (command.creates.name ?? "").trim()
      : "";
  const text =
    nominative.length > 0
      ? nominative.slice(0, PRODUCT_NAME_MAX)
      : named(param);
  return text === null ? "unsupported_param" : { name: text };
};

const renamedTo: ShoWriteParamMapper = (param) => {
  const text = named(param);
  return text === null ? "unsupported_param" : { name: text };
};

const onProduct = (action: string, reply: string): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { product: productId },
  required: ["product"],
  notes: FOCUS_NOTES,
});

const SHO_CATALOG_WRITES: ShoWritePlans = {
  [SHO_CREATE_PRODUCT]: {
    toolName: toProviderToolName(SHO_CREATE_PRODUCT),
    reply: "Товар створено.",
    params: {
      new_name: createdName,
      price: basePrice,
    },
    required: ["new_name", "price"],
  },
  [SHO_UPDATE_PRODUCT]: {
    toolName: toProviderToolName(SHO_UPDATE_PRODUCT),
    reply: "Товар оновлено.",
    params: {
      product: productId,
      rename_to: renamedTo,
      price: basePrice,
    },
    required: ["product"],
    oneOf: [["rename_to", "price"]],
    notes: UPDATE_NOTES,
  },
  [SHO_ARCHIVE_PRODUCT]: onProduct(SHO_ARCHIVE_PRODUCT, "Товар заархівовано."),
  [SHO_RESTORE_PRODUCT]: onProduct(
    SHO_RESTORE_PRODUCT,
    "Товар повернуто з архіву.",
  ),
};

export const SHO_CATALOG_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_CATALOG_WRITES);

export const SHO_CATALOG_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_CATALOG_WRITES);

export const SHO_CATALOG_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_CATALOG_WRITES);
