import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

describe("orders.searchMatches contract", () => {
  it("is a staff internal read with orders:view", () => {
    expect(searchMatchesContract.name).toBe("orders.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["orders:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.timeout).toBe(5_000);
    expect(Object.keys(searchMatchesContract.input.shape).toSorted()).toEqual([
      "customerIds",
      "limitPerType",
      "query",
    ]);
  });
});
