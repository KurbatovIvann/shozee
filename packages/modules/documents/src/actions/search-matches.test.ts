import {
  SEARCH_LIMIT_PER_TYPE_DEFAULT,
  SEARCH_QUERY_MAX,
} from "@showzy/validation/search";
import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("documents.searchMatches contract", () => {
  it("is a staff internal read with documents:view", () => {
    expect(searchMatchesContract.name).toBe("documents.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["documents:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.audit).toBe(false);
    expect(searchMatchesContract.timeout).toBe(5_000);
    expect(Object.keys(searchMatchesContract.input.shape).toSorted()).toEqual([
      "limitPerType",
      "query",
    ]);
  });

  it("accepts document hits with status and sublabel and rejects other group types", () => {
    expect(
      searchMatchesContract.output.parse({
        groups: [
          {
            type: "document",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "KA-РХ-000001",
                sublabel: "РХ",
                matchedOn: "number",
                exact: true,
                status: "cancelled",
              },
            ],
          },
        ],
      }).groups[0]?.hits[0],
    ).toEqual({
      id: ID,
      label: "KA-РХ-000001",
      sublabel: "РХ",
      matchedOn: "number",
      exact: true,
      status: "cancelled",
    });
    expect(
      searchMatchesContract.output.safeParse({
        groups: [
          {
            type: "order",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "KA-РХ-000001",
                matchedOn: "number",
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
        query: "РХ-000001",
        limitPerType: 3,
      }),
    ).toEqual({
      query: "РХ-000001",
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
        types: ["document"],
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
