import { describe, expect, it } from "vitest";

import { PRODUCT_NAME_MAX } from "../wire.contract.js";
import {
  updateProductContract,
  updateProductInputSchema,
  updateProductOutputSchema,
} from "./update-product.contract.js";

const validUpdate = {
  productId: "11111111-1111-4111-8111-111111111111",
  name: "Cake",
  basePriceMinor: "1500",
  currency: "UAH",
};

describe("catalog.updateProduct contract", () => {
  it("is an idempotent audited staff client write with products:edit and no events", () => {
    expect(updateProductContract.name).toBe("catalog.updateProduct");
    expect(updateProductContract.principal).toBe("staff");
    expect(updateProductContract.transport).toBe("client");
    expect(updateProductContract.risk).toBe("write");
    expect(updateProductContract.permissions).toEqual(["products:edit"]);
    expect(updateProductContract.aiExposure).toBe("exposed");
    expect(updateProductContract.requiresConfirmation).toBe(false);
    expect(updateProductContract.idempotent).toBe(true);
    expect(updateProductContract.audit).toBe(true);
    expect(updateProductContract.emits).toEqual([]);
    expect(updateProductContract.atomicCalls).toEqual([]);
    expect(updateProductContract.atomicCallers).toEqual([]);
    expect(updateProductContract.timeout).toBe(5_000);
    expect(updateProductContract.rateLimit).toBeUndefined();
    expect(Object.keys(updateProductOutputSchema.shape).toSorted()).toEqual([
      "basePriceMinor",
      "currency",
      "name",
      "productId",
      "variants",
    ]);
  });

  it("trims the name and rejects blank names, negative prices, oversize money, non-UAH currency, and bad ids", () => {
    expect(updateProductInputSchema.parse(validUpdate).name).toBe("Cake");
    expect(
      updateProductInputSchema.parse({
        ...validUpdate,
        name: "  Київський торт  ",
      }).name,
    ).toBe("Київський торт");
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        name: "   ",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(PRODUCT_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "-1",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "9223372036854775807",
      }).success,
    ).toBe(true);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "9223372036854775808",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        currency: "USD",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        currency: "uah",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        ...validUpdate,
        productId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("omits the name to keep it and refuses to clear it with null", () => {
    expect(
      updateProductInputSchema.safeParse({
        productId: validUpdate.productId,
        basePriceMinor: "1500",
        currency: "UAH",
      }),
    ).toMatchObject({ success: true });
    expect(
      updateProductInputSchema.safeParse({ ...validUpdate, name: null })
        .success,
    ).toBe(false);
  });

  it("omits the base price and its currency together, and never half the pair", () => {
    expect(
      updateProductInputSchema.safeParse({
        productId: validUpdate.productId,
        name: "Cake",
      }),
    ).toMatchObject({ success: true });
    expect(
      updateProductInputSchema.safeParse({ productId: validUpdate.productId }),
    ).toMatchObject({ success: true });
    expect(
      updateProductInputSchema.safeParse({
        productId: validUpdate.productId,
        basePriceMinor: "1500",
      }).success,
    ).toBe(false);
    expect(
      updateProductInputSchema.safeParse({
        productId: validUpdate.productId,
        currency: "UAH",
      }).success,
    ).toBe(false);
    for (const cleared of [
      { basePriceMinor: null, currency: null },
      { basePriceMinor: null, currency: "UAH" },
    ]) {
      expect(
        updateProductInputSchema.safeParse({ ...validUpdate, ...cleared })
          .success,
      ).toBe(false);
    }
  });

  it("rejects identifier fields — the input is strict", () => {
    for (const extra of [
      { companyId: "c" },
      { userId: "u" },
      { status: "archived" },
      { variants: [] },
    ]) {
      expect(
        updateProductInputSchema.safeParse({ ...validUpdate, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
