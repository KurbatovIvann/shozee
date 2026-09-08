/**
 * Shared staff-search caps (SHO-527 / feature SHO-526). Matcher tickets
 * T3–T7 copy these numbers; do not fork them in module Zod.
 */
export const SEARCH_QUERY_MAX = 100;
export const SEARCH_TOKEN_MAX = 8;
export const SEARCH_LIMIT_PER_TYPE_MIN = 1;
export const SEARCH_LIMIT_PER_TYPE_MAX = 10;
export const SEARCH_LIMIT_PER_TYPE_DEFAULT = 5;
export const GLOBAL_HIT_CAP = 40;
export const ORDER_CUSTOMER_LOOKUP_MAX = 20;
export const SEARCH_LABEL_MAX = 120;
export const SEARCH_SUBLABEL_MAX = 80;
/** Digits-only length after UA canonicalize (`0…` / `+380…` → `380…`). */
export const SEARCH_PHONE_MIN_DIGITS = 5;
export const SEARCH_STATUS_MAX = 40;

export const SEARCH_ENTITY_TYPES = [
  "order",
  "customer",
  "customerGroup",
  "counterparty",
  "product",
  "variant",
  "priceList",
  "document",
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const SEARCH_CUSTOMER_TYPES = [
  "customer",
  "customerGroup",
  "counterparty",
] as const;

export type SearchCustomerType = (typeof SEARCH_CUSTOMER_TYPES)[number];

export const SEARCH_CATALOG_TYPES = ["product", "variant"] as const;

export type SearchCatalogType = (typeof SEARCH_CATALOG_TYPES)[number];

/**
 * Dedup keep-order after `exact` wins: lower index is preferred.
 * `number > phone > email > edrpou > name > customer > customerNameSnapshot`.
 */
export const SEARCH_MATCHED_ON = [
  "number",
  "phone",
  "email",
  "edrpou",
  "name",
  "customer",
  "customerNameSnapshot",
] as const;

export type SearchMatchedOn = (typeof SEARCH_MATCHED_ON)[number];

export const SEARCH_MATCHED_ON_PRIORITY: Readonly<
  Record<SearchMatchedOn, number>
> = {
  number: 0,
  phone: 1,
  email: 2,
  edrpou: 3,
  name: 4,
  customer: 5,
  customerNameSnapshot: 6,
};

/**
 * Document type codes from `{prefix}-{РХ|ВН}-{seq:06}`. Duplicated here so
 * `@showzy/validation` stays a leaf (documents `document-number.ts` keeps
 * the same literals).
 */
export const SEARCH_DOCUMENT_TYPE_CODES = ["РХ", "ВН"] as const;

export type SearchDocumentTypeCode =
  (typeof SEARCH_DOCUMENT_TYPE_CODES)[number];

/** Apostrophes folded to U+0027 for name tokens. */
export const SEARCH_APOSTROPHES = ["'", "\u2019", "\u02BC"] as const;
export const SEARCH_APOSTROPHE_CANON = "'";
