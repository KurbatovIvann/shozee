import { describe, expect, it } from "vitest";

import { PRODUCT_NAME_MAX } from "../wire.contract.js";
import {
  updateVariantContract,
  updateVariantInputSchema,
  updateVariantOutputSchema,
} from "./update-variant.contract.js";

const validUpdate = {
  productId: "11111111-1111-4111-8111-111111111111",
  variantId: "22222222-2222-4222-8222-222222222222",
  name: "Slice",
};

describe("catalog.updateVariant contract", () => {
  it("is an idempotent audited staff client write with products:edit and no events", () => {
    expect(updateVariantContract.name).toBe("catalog.updateVariant");
    expect(updateVariantContract.principal).toBe("staff");
    expect(updateVariantContract.transport).toBe("client");
    expect(updateVariantContract.risk).toBe("write");
    expect(updateVariantContract.permissions).toEqual(["products:edit"]);
    expect(updateVariantContract.aiExposure).toBe("exposed");
    expect(updateVariantContract.requiresConfirmation).toBe(false);
    expect(updateVariantContract.idempotent).toBe(true);
    expect(updateVariantContract.audit).toBe(true);
    expect(updateVariantContract.emits).toEqual([]);
    expect(updateVariantContract.atomicCalls).toEqual([]);
    expect(updateVariantContract.atomicCallers).toEqual([]);
    expect(updateVariantContract.timeout).toBe(5_000);
    expect(updateVariantContract.rateLimit).toBeUndefined();
    expect(Object.keys(updateVariantOutputSchema.shape).toSorted()).toEqual([
      "basePriceMinor",
      "currency",
      "name",
      "productId",
      "variantId",
    ]);
  });

  it("trims the name and accepts a paired override or a clear", () => {
    expect(
      updateVariantInputSchema.parse({
        ...validUpdate,
        name: "  Київський торт  ",
      }).name,
    ).toBe("Київський торт");
    expect(
      updateVariantInputSchema.parse({
        ...validUpdate,
        basePriceMinor: "50",
        currency: "UAH",
      }),
    ).toMatchObject({
      basePriceMinor: "50",
      currency: "UAH",
    });
    expect(updateVariantInputSchema.parse(validUpdate).basePriceMinor).toBe(
      undefined,
    );
  });

  it("rejects blank names, unpaired override currency, negative prices, and bad ids", () => {
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        name: "   ",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(PRODUCT_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        currency: "UAH",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "50",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "50",
        currency: null,
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: null,
        currency: null,
      }).success,
    ).toBe(true);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "-1",
        currency: "UAH",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "9223372036854775808",
        currency: "UAH",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        basePriceMinor: "50",
        currency: "USD",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        productId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      updateVariantInputSchema.safeParse({
        ...validUpdate,
        variantId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("rejects identifier fields — the input is strict", () => {
    for (const extra of [
      { companyId: "c" },
      { userId: "u" },
      { status: "archived" },
    ]) {
      expect(
        updateVariantInputSchema.safeParse({ ...validUpdate, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
