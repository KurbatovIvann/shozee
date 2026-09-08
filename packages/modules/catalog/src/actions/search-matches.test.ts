import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

const ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";

describe("catalog.searchMatches contract", () => {
  it("is a staff internal read with products:view", () => {
    expect(searchMatchesContract.name).toBe("catalog.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["products:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.timeout).toBe(5_000);
  });

  it("requires productId on variant hits", () => {
    expect(
      searchMatchesContract.output.safeParse({
        groups: [
          {
            type: "variant",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "Шоколадний",
                matchedOn: "name",
                exact: false,
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      searchMatchesContract.output.parse({
        groups: [
          {
            type: "variant",
            truncated: false,
            hits: [
              {
                id: ID,
                label: "Шоколадний",
                matchedOn: "name",
                exact: false,
                productId: PRODUCT_ID,
              },
            ],
          },
        ],
      }).groups[0]?.hits[0],
    ).toEqual({
      id: ID,
      label: "Шоколадний",
      matchedOn: "name",
      exact: false,
      productId: PRODUCT_ID,
    });
  });
});
