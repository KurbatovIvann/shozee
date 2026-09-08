import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

describe("pricing.searchMatches contract", () => {
  it("is a staff internal read with pricing:view", () => {
    expect(searchMatchesContract.name).toBe("pricing.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["pricing:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.timeout).toBe(5_000);
  });
});
