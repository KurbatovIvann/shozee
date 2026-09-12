import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import { contractQueryKey } from "../../../api/query-options";
import {
  LIST_CUSTOMERS_ACTION,
  listOrderCustomersInfiniteOptions,
  orderCustomersLookupInput,
  ORDER_CUSTOMERS_LOOKUP_INPUT,
  type OrderCustomersListClient,
} from "./order-customers-query";

function stubCustomersClient(
  onListCustomers: OrderCustomersListClient["client"]["customers"]["listCustomers"],
): OrderCustomersListClient {
  return { client: { customers: { listCustomers: onListCustomers } } };
}

describe("orderCustomersLookupInput", () => {
  it("omits search when undefined and includes it otherwise", () => {
    expect(orderCustomersLookupInput(undefined)).toEqual(
      ORDER_CUSTOMERS_LOOKUP_INPUT,
    );
    expect(orderCustomersLookupInput("марія")).toEqual({
      ...ORDER_CUSTOMERS_LOOKUP_INPUT,
      search: "марія",
    });
  });
});

describe("listOrderCustomersInfiniteOptions", () => {
  it("keys [actionName, companyId, input] for active customers, includes search in the key, and keeps cursor out of it", () => {
    const companyA = listOrderCustomersInfiniteOptions({
      client: null,
      companyId: "company-a",
      input: orderCustomersLookupInput("марія"),
      getActiveCompany: () => "company-a",
    });
    const companyB = listOrderCustomersInfiniteOptions({
      client: null,
      companyId: "company-b",
      input: orderCustomersLookupInput("марія"),
      getActiveCompany: () => "company-b",
    });
    expect(companyA.queryKey).toEqual(
      contractQueryKey(LIST_CUSTOMERS_ACTION, "company-a", {
        ...ORDER_CUSTOMERS_LOOKUP_INPUT,
        search: "марія",
      }),
    );
    expect(companyA.queryKey).not.toEqual(companyB.queryKey);
    expect(companyA.queryKey[1]).toBe("company-a");
    expect(JSON.stringify(companyA.queryKey)).not.toContain("cursor");
    expect(companyA.enabled).toBe(false);
  });

  it("sends the typed search term to customers.listCustomers and fetches exactly one page at mount", async () => {
    const calls: unknown[] = [];
    const client = stubCustomersClient((input) => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: "cursor-1" });
    });
    const options = listOrderCustomersInfiniteOptions({
      client,
      companyId: "company-a",
      input: orderCustomersLookupInput("марія"),
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      ...ORDER_CUSTOMERS_LOOKUP_INPUT,
      search: "марія",
    });
    queryClient.clear();
  });
});
