import { describe, expect, it } from "vitest";

import {
  getProductContract,
  getProductInputSchema,
} from "./get-product.contract.js";

const validId = "11111111-1111-4111-8111-111111111111";

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
    expect(getProductContract.errors.toSorted()).toEqual([
      "CONFLICT",
      "NOT_FOUND",
      "VALIDATION",
    ]);
  });

  it("takes exactly one of a product id and a human query", () => {
    expect(getProductInputSchema.parse({ productId: validId })).toEqual({
      productId: validId,
    });
    expect(getProductInputSchema.parse({ productQuery: " Наполеон " })).toEqual(
      { productQuery: "Наполеон" },
    );
    expect(getProductInputSchema.safeParse({}).success).toBe(false);
    expect(
      getProductInputSchema.safeParse({
        productId: validId,
        productQuery: "Наполеон",
      }).success,
    ).toBe(false);
    expect(
      getProductInputSchema.safeParse({ productId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      getProductInputSchema.safeParse({ productQuery: "x".repeat(101) })
        .success,
    ).toBe(false);
  });
});
