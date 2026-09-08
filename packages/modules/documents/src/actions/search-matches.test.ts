import { describe, expect, it } from "vitest";

import { searchMatchesContract } from "./search-matches.contract.js";

describe("documents.searchMatches contract", () => {
  it("is a staff internal read with documents:view", () => {
    expect(searchMatchesContract.name).toBe("documents.searchMatches");
    expect(searchMatchesContract.principal).toBe("staff");
    expect(searchMatchesContract.transport).toBe("internal");
    expect(searchMatchesContract.risk).toBe("read");
    expect(searchMatchesContract.permissions).toEqual(["documents:view"]);
    expect(searchMatchesContract.aiExposure).toBe("internal");
    expect(searchMatchesContract.timeout).toBe(5_000);
  });
});
