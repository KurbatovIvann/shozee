import { describe, expect, it } from "vitest";

import { contractQueryKey } from "../../../api/query-options";
import {
  GET_PRODUCT_ACTION,
  LIST_PRODUCTS_ACTION,
  getOrderCatalogProductQueryOptions,
  listOrderProductsInfiniteOptions,
  orderProductsLookupInput,
  ORDER_PRODUCTS_LOOKUP_INPUT,
} from "./order-catalog-query";

const PRODUCT_ID = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

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
});
