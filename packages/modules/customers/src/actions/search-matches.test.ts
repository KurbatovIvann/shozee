import { describe, expect, it } from "vitest";

import {
  ORDER_CUSTOMER_LOOKUP_MAX,
  SEARCH_CUSTOMER_TYPES,
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_QUERY_MAX,
} from "@showzy/validation/search";

import { searchMatchesContract } from "./search-matches.contract.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("customers.searchMatches contract", () => {
  it("is a staff internal read with customers:view", () => {
    expect(searchMatchesContract.name).toBe("customers.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["customers:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.audit).toBe(false);
    expect(searchMatchesContract.timeout).toBe(5_000);
  });

  it("includes orderCustomerLookup separate from display groups", () => {
    const parsed = searchMatchesContract.output.parse({
      groups: [
        {
          type: "customer",
          truncated: true,
          hits: [
            {
              id: ID,
              label: "Олена",
              matchedOn: "name",
              exact: true,
            },
          ],
        },
      ],
      orderCustomerLookup: {
        ids: [ID],
        truncated: false,
      },
    });
    expect(parsed.orderCustomerLookup.truncated).toBe(false);
    expect(parsed.groups[0]?.truncated).toBe(true);
    expect(parsed.orderCustomerLookup.ids).toHaveLength(1);
    expect(ORDER_CUSTOMER_LOOKUP_MAX).toBe(20);
    expect(
      searchMatchesContract.output.safeParse({
        groups: [],
      }).success,
    ).toBe(false);
  });

  it("accepts an empty query and rejects extras, oversize, and companyId", () => {
    expect(searchMatchesContract.input.parse({ query: "" })).toEqual({
      query: "",
      limitPerType: SEARCH_LIMIT_PER_TYPE_DEFAULT,
    });
    expect(
      searchMatchesContract.input.parse({
        query: "мак",
        types: [...SEARCH_CUSTOMER_TYPES],
        limitPerType: 3,
      }),
    ).toEqual({
      query: "мак",
      types: ["customer", "customerGroup", "counterparty"],
      limitPerType: 3,
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
        types: ["order"],
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
