import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("./use-order-form-lookups.ts", import.meta.url),
  "utf8",
);

describe("useOrderFormLookups server search", () => {
  it("feeds the debounced search term into the contract input builders", () => {
    expect(SOURCE).toContain("orderCustomersLookupInput(customerSearch)");
    expect(SOURCE).toContain("orderProductsLookupInput(productSearch)");
    expect(SOURCE).toContain("normalizeOrderCustomerSearch(");
    expect(SOURCE).toContain("normalizeOrderProductQuery(");
    expect(SOURCE).toContain("useDebouncedValue(");
  });

  it("pages on demand instead of draining every page at mount", () => {
    expect(SOURCE).not.toContain("useDrainInfinitePages");
    expect(SOURCE).toContain(
      "customersHasNextPage && !customersFetchingNextPage",
    );
    expect(SOURCE).toContain(
      "productsHasNextPage && !productsFetchingNextPage",
    );
  });

  it("exposes controlled query state and loading-more flags for the sheets", () => {
    expect(SOURCE).toContain("onCustomerQueryChange: setCustomerQuery");
    expect(SOURCE).toContain("onProductQueryChange: setProductQuery");
    expect(SOURCE).toContain("customersLoadingMore: customersQuery.isFetching");
    expect(SOURCE).toContain("productsLoadingMore: productsQuery.isFetching");
  });
});
