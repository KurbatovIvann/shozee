import {
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_QUERY_MAX,
} from "@showzy/validation/search";
import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("pricing.searchMatches contract", () => {
  it("is a staff internal read with pricing:view", () => {
    expect(searchMatchesContract.name).toBe("pricing.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["pricing:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.audit).toBe(false);
    expect(searchMatchesContract.timeout).toBe(5_000);
  });

  it("accepts priceList hits with status and rejects other group types", () => {
    expect(
      searchMatchesContract.output.parse({
        groups: [
          {
            type: "priceList",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "Макаронс",
                matchedOn: "name",
                exact: true,
                status: "inactive",
              },
            ],
          },
        ],
      }).groups[0]?.hits[0],
    ).toEqual({
      id: ID,
      label: "Макаронс",
      matchedOn: "name",
      exact: true,
      status: "inactive",
    });
    expect(
      searchMatchesContract.output.safeParse({
        groups: [
          {
            type: "product",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "Макаронс",
                matchedOn: "name",
                exact: true,
              },
            ],
          },
        ],
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
        limitPerType: 3,
      }),
    ).toEqual({
      query: "мак",
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
        types: ["priceList"],
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
