import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import {
  listOrderProductsInfiniteOptions,
  orderProductsLookupInput,
  type OrderProductsListClient,
} from "../api/order-catalog-query";
import {
  listOrderCustomersInfiniteOptions,
  orderCustomersLookupInput,
  type OrderCustomersListClient,
} from "../api/order-customers-query";
import {
  normalizeOrderCustomerSearch,
  normalizeOrderProductQuery,
} from "../shared/order-caps";
import { draftLineThumbnailItems } from "../shared/order-thumbnails";

const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "22222222-2222-4222-8222-222222222222";
const FILE_A = "33333333-3333-4333-8333-333333333333";

describe("order form lookups server search", () => {
  it("carries the typed customer search through normalization into customers.listCustomers, one page at mount", async () => {
    const calls: unknown[] = [];
    const client: OrderCustomersListClient = {
      client: {
        customers: {
          listCustomers: (input) => {
            calls.push(input);
            return Promise.resolve({ items: [], nextCursor: "cursor-1" });
          },
        },
      },
    };
    const search = normalizeOrderCustomerSearch("  Марія  ");
    const options = listOrderCustomersInfiniteOptions({
      client,
      companyId: "company-a",
      input: orderCustomersLookupInput(search),
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ search: "Марія" });
    queryClient.clear();
  });

  it("carries the typed product query through normalization into catalog.listProducts, one page at mount", async () => {
    const calls: unknown[] = [];
    const client: OrderProductsListClient = {
      client: {
        catalog: {
          listProducts: (input) => {
            calls.push(input);
            return Promise.resolve({ items: [], nextCursor: null });
          },
        },
      },
    };
    const query = normalizeOrderProductQuery("  торт  ");
    const options = listOrderProductsInfiniteOptions({
      client,
      companyId: "company-a",
      input: orderProductsLookupInput(query),
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ query: "торт" });
    queryClient.clear();
  });
});

describe("draftLineThumbnailItems", () => {
  it("joins a draft line's product image from its own catalog fetch, independent of the current search page", () => {
    expect(
      draftLineThumbnailItems(
        [PRODUCT_A, PRODUCT_B],
        [PRODUCT_B, PRODUCT_A],
        [undefined, [FILE_A]],
      ),
    ).toEqual([
      { productId: PRODUCT_A, primaryImageFileId: FILE_A },
      { productId: PRODUCT_B, primaryImageFileId: null },
    ]);
  });

  it("returns null when the product has not been fetched or has no images", () => {
    expect(draftLineThumbnailItems([PRODUCT_A], [], [])).toEqual([
      { productId: PRODUCT_A, primaryImageFileId: null },
    ]);
  });
});
