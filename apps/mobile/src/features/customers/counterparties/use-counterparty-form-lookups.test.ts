import { describe, expect, it } from "vitest";

import { createShowzyQueryClient } from "../../../api/query-client";
import {
  listCustomersInfiniteOptions,
  type CustomersListClient,
} from "../api/customer.queries";
import {
  CUSTOMERS_LOOKUP_PAGE_SIZE,
  LIST_CUSTOMERS_SEARCH_MAX,
} from "../shared/customer-caps";
import { normalizeCustomersSearch } from "../shared/paged-list";

function stubCustomersClient(
  onListCustomers: CustomersListClient["client"]["customers"]["listCustomers"],
): CustomersListClient {
  return { client: { customers: { listCustomers: onListCustomers } } };
}

describe("counterparty form lookups server search", () => {
  it("carries the typed customer term through normalization into customers.listCustomers, one page at mount", async () => {
    const calls: unknown[] = [];
    const client = stubCustomersClient((input) => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: "cursor-1" });
    });
    const search = normalizeCustomersSearch(
      "  Марія  ",
      LIST_CUSTOMERS_SEARCH_MAX,
    );
    const options = listCustomersInfiniteOptions({
      client,
      companyId: "company-a",
      input: {
        status: "active",
        limit: CUSTOMERS_LOOKUP_PAGE_SIZE,
        ...(search === undefined ? {} : { search }),
      },
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      status: "active",
      limit: CUSTOMERS_LOOKUP_PAGE_SIZE,
      search: "Марія",
    });
    queryClient.clear();
  });

  it("omits search from customers.listCustomers when the typed term is blank", async () => {
    const calls: unknown[] = [];
    const client = stubCustomersClient((input) => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const search = normalizeCustomersSearch("   ", LIST_CUSTOMERS_SEARCH_MAX);
    const options = listCustomersInfiniteOptions({
      client,
      companyId: "company-a",
      input: {
        status: "active",
        limit: CUSTOMERS_LOOKUP_PAGE_SIZE,
        ...(search === undefined ? {} : { search }),
      },
      getActiveCompany: () => "company-a",
    });
    const queryClient = createShowzyQueryClient({ retryDelay: () => 0 });
    await queryClient.fetchInfiniteQuery({ ...options, retry: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      status: "active",
      limit: CUSTOMERS_LOOKUP_PAGE_SIZE,
    });
    queryClient.clear();
  });
});
