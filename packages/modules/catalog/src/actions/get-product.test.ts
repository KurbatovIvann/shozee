import { describe, expect, it } from "vitest";

import { getProductContract } from "./get-product.contract.js";

describe("catalog.getProduct contract", () => {
  it("is a staff client read with products:view", () => {
    expect(getProductContract.name).toBe("catalog.getProduct");
    expect(getProductContract.principal).toBe("staff");
    expect(getProductContract.transport).toBe("client");
    expect(getProductContract.risk).toBe("read");
    expect(getProductContract.permissions).toEqual(["products:view"]);
    expect(getProductContract.aiExposure).toBe("exposed");
    expect(getProductContract.audit).toBe(false);
    expect(getProductContract.idempotent).toBe(false);
    expect(getProductContract.emits).toEqual([]);
    expect(getProductContract.timeout).toBe(5_000);
  });
});
