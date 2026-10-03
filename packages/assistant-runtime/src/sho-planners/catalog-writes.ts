import { toProviderToolName } from "@showzy/ai";
import type { ShoParam } from "@showzy/sho-protocol";
import {
  DEFAULT_PRODUCT_CURRENCY,
  PRODUCT_NAME_MAX,
} from "@showzy/validation/catalog";

import { shoIsRef, shoRefused, type ShoActionPlanners } from "./kit.js";
import {
  shoCreatedName,
  shoIdFrom,
  shoIdOnly,
  shoMoneyOf,
  shoRenamedName,
  shoVariantId,
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

export const SHO_CREATE_VARIANT = "catalog.createVariant";

export const SHO_UPDATE_VARIANT = "catalog.updateVariant";

export const SHO_ARCHIVE_VARIANT = "catalog.archiveVariant";

export const SHO_RESTORE_VARIANT = "catalog.restoreVariant";

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

export const SHO_READ_AS_VARIANT_UPDATE_NOTE =
  "Прочитано як редагування варіанта, не створення";

export const SHO_UNKNOWN_VARIANT_ATTR_NOTE =
  "Ознаку варіанта не впізнано, вибрано за рештою";

const VARIANT_NOTES: Readonly<Record<string, string>> = {
  unknown_attr: SHO_UNKNOWN_VARIANT_ATTR_NOTE,
};

const VARIANT_UPDATE_NOTES: Readonly<Record<string, string>> = {
  ...VARIANT_NOTES,
  read_as_update: SHO_READ_AS_VARIANT_UPDATE_NOTE,
};

const basePrice: ShoWriteParamMapper = (param) => {
  const money = shoMoneyOf(param);
  return money === null || money.currency !== DEFAULT_PRODUCT_CURRENCY
    ? "unsupported_param"
    : {
        basePriceMinor: String(money.minor),
        currency: DEFAULT_PRODUCT_CURRENCY,
      };
};

const product = shoIdOnly("productId");

const createdName = shoCreatedName("product", PRODUCT_NAME_MAX);

const renamedTo = shoRenamedName(PRODUCT_NAME_MAX);

const onProduct = (action: string, reply: string): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { product },
  required: ["product"],
  notes: FOCUS_NOTES,
});

const variantName = shoRenamedName(PRODUCT_NAME_MAX);

const resolvedProduct = (param: ShoParam): ShoWriteMapped =>
  shoIsRef(param) && param.status === "resolved"
    ? shoIdFrom(param, "productId")
    : "unsupported_param";

const locatingProduct: ShoWriteParamMapper = (param) => {
  const bound = resolvedProduct(param);
  return shoRefused(bound) ? bound : {};
};

const onVariant = (action: string, reply: string): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { variant: shoVariantId, product: locatingProduct },
  required: ["variant"],
  notes: VARIANT_NOTES,
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
      product,
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
  [SHO_CREATE_VARIANT]: {
    toolName: toProviderToolName(SHO_CREATE_VARIANT),
    reply: "Варіант створено.",
    params: {
      product,
      new_name: variantName,
      price: basePrice,
    },
    required: ["product", "new_name"],
  },
  [SHO_UPDATE_VARIANT]: {
    toolName: toProviderToolName(SHO_UPDATE_VARIANT),
    reply: "Варіант оновлено.",
    params: {
      variant: shoVariantId,
      product: resolvedProduct,
      rename_to: variantName,
      price: basePrice,
    },
    required: ["variant", "product"],
    oneOf: [["rename_to", "price"]],
    notes: VARIANT_UPDATE_NOTES,
  },
  [SHO_ARCHIVE_VARIANT]: onVariant(
    SHO_ARCHIVE_VARIANT,
    "Варіант заархівовано.",
  ),
  [SHO_RESTORE_VARIANT]: onVariant(
    SHO_RESTORE_VARIANT,
    "Варіант повернуто з архіву.",
  ),
};

export const SHO_CATALOG_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_CATALOG_WRITES);

export const SHO_CATALOG_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_CATALOG_WRITES);

export const SHO_CATALOG_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_CATALOG_WRITES);
