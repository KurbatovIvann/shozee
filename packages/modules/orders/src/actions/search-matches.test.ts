import { describe, expect, it } from "vitest";

import {
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_QUERY_MAX,
} from "@showzy/validation/search";

import { searchMatchesContract } from "./search-matches.contract.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("orders.searchMatches contract", () => {
  it("is a staff internal read with orders:view", () => {
    expect(searchMatchesContract.name).toBe("orders.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["orders:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.audit).toBe(false);
    expect(searchMatchesContract.timeout).toBe(5_000);
    expect(Object.keys(searchMatchesContract.input.shape).toSorted()).toEqual([
      "customerIds",
      "limitPerType",
      "query",
    ]);
  });

  it("accepts an empty query and rejects extras, oversize, and companyId", () => {
    expect(searchMatchesContract.input.parse({ query: "" })).toEqual({
      query: "",
      limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
    });
    expect(
      searchMatchesContract.input.parse({
        query: "32KUY41",
        limitPerType: 3,
        customerIds: [ID],
      }),
    ).toEqual({
      query: "32KUY41",
      limitPerType: 3,
      customerIds: [ID],
    });
    expect(
      searchMatchesContract.input.safeParse({
        query: "x".repeat(SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      searchMatchesContract.input.safeParse({ query: "мак", limitPerType: 0 })
        .success,
    ).toBe(false);
    expect(
      searchMatchesContract.input.safeParse({ query: "мак", limitPerType: 11 })
        .success,
    ).toBe(false);
    expect(
      searchMatchesContract.input.safeParse({
        query: "мак",
        customerIds: Array.from(
          { length: ORDER_CUSTOMER_LOOKUP_MAX + 1 },
          () => ID,
        ),
      }).success,
    ).toBe(false);
    expect(
      searchMatchesContract.input.safeParse({
        query: "мак",
        companyId: ID,
      }).success,
    ).toBe(false);
  });
});
