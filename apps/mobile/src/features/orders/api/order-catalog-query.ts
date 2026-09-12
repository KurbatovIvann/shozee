/**
 * `catalog.listProducts` + `catalog.getProduct` for the order editor
 * (SHO-213). Keys follow SHO-102: `[actionName, companyId, input]`.
 * Orders-owned so the editor does not import `features/catalog`.
 * Never reads `basePriceMinor` as a line price (owner decision 2).
 */
import type { ContractClient } from "../../../api/client";
import {
  contractInfiniteQueryOptions,
  contractQueryOptions,
} from "../../../api/query-options";
import { ORDER_LOOKUP_PAGE_SIZE } from "../shared/order-caps";

export const LIST_PRODUCTS_ACTION = "catalog.listProducts";
export const GET_PRODUCT_ACTION = "catalog.getProduct";

type ShowzyClient = ContractClient;
export type ListProductsOutput = Awaited<
  ReturnType<ShowzyClient["client"]["catalog"]["listProducts"]>
>;
export type OrderProductListItem = ListProductsOutput["items"][number];
export type GetProductOutput = Awaited<
  ReturnType<ShowzyClient["client"]["catalog"]["getProduct"]>
>;
export type GetProductVariant = GetProductOutput["variants"][number];

export const ORDER_PRODUCTS_LOOKUP_INPUT = {
  status: "active" as const,
  limit: ORDER_LOOKUP_PAGE_SIZE,
};

export type ListOrderProductsPageInput = typeof ORDER_PRODUCTS_LOOKUP_INPUT & {
  readonly query?: string;
};

export function orderProductsLookupInput(
  query: string | undefined,
): ListOrderProductsPageInput {
  return {
    ...ORDER_PRODUCTS_LOOKUP_INPUT,
    ...(query === undefined ? {} : { query }),
  };
}

export function listOrderProductsInfiniteOptions(args: {
  readonly client: ContractClient | null;
  readonly companyId: string | null;
  readonly input: ListOrderProductsPageInput;
  readonly getActiveCompany: () => string | null;
  readonly enabled?: boolean;
}) {
  const client = args.client;
  return {
    ...contractInfiniteQueryOptions({
      actionName: LIST_PRODUCTS_ACTION,
      companyId: args.companyId,
      input: args.input,
      getActiveCompany: args.getActiveCompany,
      queryFn: (cursor: string | null) => {
        if (client === null) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return client.client.catalog.listProducts({
          ...args.input,
          ...(cursor === null ? {} : { cursor }),
        });
      },
      nextCursor: (page: ListProductsOutput) => page.nextCursor,
    }),
    enabled:
      (args.enabled ?? true) && client !== null && args.companyId !== null,
  };
}

export function getOrderCatalogProductQueryOptions(args: {
  readonly client: ContractClient | null;
  readonly companyId: string | null;
  readonly productId: string | null;
  readonly getActiveCompany: () => string | null;
}) {
  const client = args.client;
  const productId = args.productId ?? "";
  return {
    ...contractQueryOptions({
      actionName: GET_PRODUCT_ACTION,
      companyId: args.companyId,
      input: { productId },
      getActiveCompany: args.getActiveCompany,
      queryFn: () => {
        if (client === null) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return client.client.catalog.getProduct({ productId });
      },
    }),
    enabled:
      client !== null && args.companyId !== null && args.productId !== null,
  };
}
