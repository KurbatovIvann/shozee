import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import { contractQueryKey } from "../../../api/query-options";
import {
  GET_PRODUCT_ACTION,
  LIST_PRODUCTS_ACTION,
  getOrderCatalogProductQueryOptions,
  listOrderProductsInfiniteOptions,
  orderProductsLookupInput,
  ORDER_PRODUCTS_LOOKUP_INPUT,
  type OrderCatalogProductClient,
  type OrderProductsListClient,
} from "./order-catalog-query";

const PRODUCT_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

function stubProductsListClient(
  onListProducts: OrderProductsListClient["client"]["catalog"]["listProducts"],
): OrderProductsListClient {
  return { client: { catalog: { listProducts: onListProducts } } };
}

function stubGetProductClient(
  onGetProduct: OrderCatalogProductClient["client"]["catalog"]["getProduct"],
): OrderCatalogProductClient {
  return { client: { catalog: { getProduct: onGetProduct } } };
}

describe("orderProductsLookupInput", () => {
  it("omits query when undefined and includes it otherwise", () => {
    expect(orderProductsLookupInput(undefined)).toEqual(
      ORDER_PRODUCTS_LOOKUP_INPUT,
    );
    expect(orderProductsLookupInput("торт")).toEqual({
      ...ORDER_PRODUCTS_LOOKUP_INPUT,
      query: "торт",
    });
  });
});

describe("listOrderProductsInfiniteOptions", () => {
  it("keys [actionName, companyId, input] for active products, includes query in the key, and keeps cursor out of it", () => {
    const companyA = listOrderProductsInfiniteOptions({
      client: null,
      companyId: "company-a",
      input: orderProductsLookupInput("торт"),
      getActiveCompany: () => "company-a",
    });
    const companyB = listOrderProductsInfiniteOptions({
      client: null,
      companyId: "company-b",
      input: orderProductsLookupInput("торт"),
      getActiveCompany: () => "company-b",
    });
    expect(companyA.queryKey).toEqual(
      contractQueryKey(LIST_PRODUCTS_ACTION, "company-a", {
        ...ORDER_PRODUCTS_LOOKUP_INPUT,
        query: "торт",
      }),
    );
    expect(companyA.queryKey).not.toEqual(companyB.queryKey);
    expect(companyA.queryKey[1]).toBe("company-a");
    expect(JSON.stringify(companyA.queryKey)).not.toContain("cursor");
    expect(companyA.enabled).toBe(false);
  });

  it("sends the typed search term to catalog.listProducts and fetches exactly one page at mount", async () => {
    const calls: unknown[] = [];
    const client = stubProductsListClient((input) => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: "cursor-1" });
    });
    const options = listOrderProductsInfiniteOptions({
      client,
      companyId: "company-a",
      input: orderProductsLookupInput("торт"),
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      ...ORDER_PRODUCTS_LOOKUP_INPUT,
      query: "торт",
    });
    queryClient.clear();
  });
});

describe("getOrderCatalogProductQueryOptions", () => {
  it("keys by action, company selector, and productId", () => {
    const options = getOrderCatalogProductQueryOptions({
      client: null,
      companyId: "company-a",
      productId: PRODUCT_ID,
      getActiveCompany: () => "company-a",
    });
    expect(options.queryKey).toEqual(
      contractQueryKey(GET_PRODUCT_ACTION, "company-a", {
        productId: PRODUCT_ID,
      }),
    );
    expect(options.queryKey[1]).toBe("company-a");
  });

  it("stays disabled without a client, company, or product id", () => {
    expect(
      getOrderCatalogProductQueryOptions({
        client: null,
        companyId: "company-a",
        productId: PRODUCT_ID,
        getActiveCompany: () => "company-a",
      }).enabled,
    ).toBe(false);
    expect(
      getOrderCatalogProductQueryOptions({
        client: null,
        companyId: "company-a",
        productId: null,
        getActiveCompany: () => "company-a",
      }).enabled,
    ).toBe(false);
  });

  it("sends the productId to catalog.getProduct", async () => {
    const calls: unknown[] = [];
    const client = stubGetProductClient((input) => {
      calls.push(input);
      return Promise.resolve({
        id: PRODUCT_ID,
        name: "Торт",
        basePriceMinor: "0",
        currency: "UAH",
        status: "active",
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:00:00.000Z",
        variants: [],
        imageFileIds: [],
      });
    });
    const options = getOrderCatalogProductQueryOptions({
      client,
      companyId: "company-a",
      productId: PRODUCT_ID,
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchQuery({ ...options, retry: false });
    expect(calls).toEqual([{ productId: PRODUCT_ID }]);
    queryClient.clear();
  });
});
