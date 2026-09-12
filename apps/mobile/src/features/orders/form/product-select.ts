/**
 * Product picker row view-model (SHO-242 / SHO-249). Kept out of the
 * sheet so the form hook does not import JSX.
 */
import { interpolate } from "../../../i18n/locale";
import type { ProductPickerPick } from "./product-picker";
import { productPickerSelectedVariantNames } from "./product-picker";

export type ProductSelectRow = {
  readonly id: string;
  readonly name: string;
  readonly hasVariants: boolean;
  readonly variantsLabel: string;
  readonly thumbnailFileId: string | null;
  readonly thumbnailUrl: string | null;
  readonly thumbnailFailed: boolean;
};

export type ProductSelectVariantRow = {
  readonly id: string;
  readonly name: string;
};

export type ProductSelectLevel = "products" | "variants";

export type ProductVariantsLoadStatus = "idle" | "loading" | "ready" | "error";

const EMPTY_PRODUCT_SELECT_ROWS: readonly ProductSelectRow[] = [];

/**
 * Product-sheet search. Closed sessions return a stable empty array
 * without walking the catalog (the sheet stays mounted in the form).
 */
export function filterProductSelectRows(
  products: readonly ProductSelectRow[],
  query: string,
  sessionOpen: boolean,
): readonly ProductSelectRow[] {
  if (!sessionOpen) {
    return EMPTY_PRODUCT_SELECT_ROWS;
  }
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return products;
  }
  return products.filter((product) =>
    product.name.toLowerCase().includes(normalized),
  );
}

/**
 * Parent-row subtitle: variant count until the session has picks for
 * this product, then selected count · names (uk/en templates).
 */
export function visibleProductSelectRows(args: {
  readonly products: readonly ProductSelectRow[];
  readonly query: string;
  readonly sessionOpen: boolean;
  readonly serverFiltered: boolean;
}): readonly ProductSelectRow[] {
  if (!args.sessionOpen) {
    return EMPTY_PRODUCT_SELECT_ROWS;
  }
  if (args.serverFiltered) {
    return args.products;
  }
  return filterProductSelectRows(args.products, args.query, args.sessionOpen);
}

export type ProductSelectListState =
  | { readonly kind: "loading" }
  | { readonly kind: "empty" }
  | { readonly kind: "items"; readonly items: readonly ProductSelectRow[] };

export function resolveProductSelectListState(args: {
  readonly products: readonly ProductSelectRow[];
  readonly query: string;
  readonly sessionOpen: boolean;
  readonly serverFiltered: boolean;
  readonly loadingMore: boolean;
}): ProductSelectListState {
  const items = visibleProductSelectRows(args);
  if (items.length > 0) {
    return { kind: "items", items };
  }
  if (args.sessionOpen && args.serverFiltered && args.loadingMore) {
    return { kind: "loading" };
  }
  return { kind: "empty" };
}

export function productPickerParentSubtitle(args: {
  readonly variantCount: number;
  readonly selectedNames: readonly string[];
  readonly noneLabel: string;
  readonly countLabel: string;
  readonly selectedLabel: string;
}): string {
  if (args.variantCount === 0) {
    return args.noneLabel;
  }
  if (args.selectedNames.length === 0) {
    return args.countLabel;
  }
  return interpolate(args.selectedLabel, {
    count: String(args.selectedNames.length),
    names: args.selectedNames.join(", "),
  });
}

export function productPickerParentSelectedNames(
  picks: readonly ProductPickerPick[],
  productId: string,
): readonly string[] {
  return productPickerSelectedVariantNames(picks, productId);
}
