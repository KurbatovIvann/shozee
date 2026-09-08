import { describe, expect, it } from "vitest";

import { SEARCH_QUERY_MAX } from "@showzy/validation/search";

import { queryContract } from "./query.contract.js";

describe("search.query contract", () => {
  it("is a staff client read opened by companies:view, not a new search:query key", () => {
    expect(queryContract.name).toBe("search.query");
    expect(queryContract.principal).toBe("staff");
    expect(queryContract.transport).toBe("client");
    expect(queryContract.risk).toBe("read");
    expect(queryContract.permissions).toEqual(["companies:view"]);
    expect(queryContract.permissions).not.toEqual([]);
    expect(queryContract.aiExposure).toBe("internal");
    expect(queryContract.audit).toBe(false);
    expect(queryContract.idempotent).toBe(false);
    expect(queryContract.emits).toEqual([]);
    expect(queryContract.timeout).toBe(10_000);
    expect(
      queryContract.input.safeParse({ query: "мак", cursor: "next" }).success,
    ).toBe(false);
    expect(
      queryContract.output.parse({
        groups: [],
        searchedTypes: ["order"],
        queryNormalized: "мак",
      }),
    ).toEqual({
      groups: [],
      searchedTypes: ["order"],
      queryNormalized: "мак",
    });
  });

  it("allows empty query up to SEARCH_QUERY_MAX and rejects extras", () => {
    expect(queryContract.input.parse({ query: "" })).toEqual({
      query: "",
      limitPerType: 5,
    });
    expect(
      queryContract.input.safeParse({
        query: "x".repeat(SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      queryContract.input.safeParse({
        query: "мак",
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });
});
