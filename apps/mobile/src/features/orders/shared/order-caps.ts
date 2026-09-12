/**
 * Create-form ceilings from `@showzy/validation/orders` (SHO-423). Same
 * numbers as `orders.create`. Mobile cannot import module contracts.
 */
import { LIST_PRODUCTS_QUERY_MAX } from "@showzy/validation/catalog";
import { LIST_CUSTOMERS_SEARCH_MAX } from "@showzy/validation/customers";

export {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
} from "@showzy/validation/orders";
export { LIST_CUSTOMERS_SEARCH_MAX, LIST_PRODUCTS_QUERY_MAX };

export function normalizeOrderCustomerSearch(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, LIST_CUSTOMERS_SEARCH_MAX);
}

export function normalizeOrderProductQuery(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, LIST_PRODUCTS_QUERY_MAX);
}

/**
 * `LIST_ORDERS_QUERY_MAX` on `orders.list` (SHO-240). Same 100 cap as
 * catalog/customers list search.
 */
export const LIST_ORDERS_QUERY_MAX = 100;

/** Page size for drained customer/product pickers (contract list max). */
export const ORDER_LOOKUP_PAGE_SIZE = 50;

/** `quantityMilli` scale 3: `1000` = 1 unit. */
export const QUANTITY_MILLI_PER_UNIT = 1000n;

export const DEFAULT_LINE_QUANTITY_MILLI = "1000";

/**
 * Whole-unit stepper ceiling (SHO-305). `quantityMilli` stays a
 * canonical positive integer whose unit conversion fits JS number.
 * 999_999_999 units → 12-digit milli, matching the archived create
 * wire `^[1-9][0-9]{0,11}$` length.
 */
export const MAX_LINE_QUANTITY_UNITS = 999_999_999;

/** Canvas comment textarea — Class B via TextField multiline. */
export const ORDER_COMMENT_LINES = 4;
