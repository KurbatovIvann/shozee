import { describe, expect, it } from "vitest";

import {
  SET_PRODUCT_IMAGES_MAX,
  setProductImagesContract,
  setProductImagesInputSchema,
  setProductImagesOutputSchema,
} from "./set-product-images.contract.js";

const productId = "11111111-1111-4111-8111-111111111111";
const fileA = "22222222-2222-4222-8222-222222222222";
const fileB = "33333333-3333-4333-8333-333333333333";

describe("catalog.setProductImages contract", () => {
  it("is an idempotent audited staff client write with products:edit, 10s timeout, and no events", () => {
    expect(setProductImagesContract.name).toBe("catalog.setProductImages");
    expect(setProductImagesContract.principal).toBe("staff");
    expect(setProductImagesContract.transport).toBe("client");
    expect(setProductImagesContract.risk).toBe("write");
    expect(setProductImagesContract.permissions).toEqual(["products:edit"]);
    expect(setProductImagesContract.aiExposure).toBe("internal");
    expect(setProductImagesContract.requiresConfirmation).toBe(false);
    expect(setProductImagesContract.idempotent).toBe(true);
    expect(setProductImagesContract.audit).toBe(true);
    expect(setProductImagesContract.emits).toEqual([]);
    expect(setProductImagesContract.atomicCalls).toEqual([]);
    expect(setProductImagesContract.atomicCallers).toEqual([]);
    expect(setProductImagesContract.timeout).toBe(10_000);
    expect(setProductImagesContract.rateLimit).toBeUndefined();
    expect(SET_PRODUCT_IMAGES_MAX).toBe(10);
    expect(Object.keys(setProductImagesOutputSchema.shape).toSorted()).toEqual([
      "fileIds",
      "productId",
    ]);
  });

  it("allows an empty list (clear) and rejects oversized batches, duplicates, and bad ids", () => {
    expect(
      setProductImagesInputSchema.parse({ productId, fileIds: [] }),
    ).toEqual({ productId, fileIds: [] });
    expect(
      setProductImagesInputSchema.parse({
        productId,
        fileIds: [fileA, fileB],
      }).fileIds,
    ).toEqual([fileA, fileB]);
    expect(
      setProductImagesInputSchema.safeParse({
        productId,
        fileIds: Array.from({ length: SET_PRODUCT_IMAGES_MAX + 1 }, (_, i) => {
          const tail = String(i + 1).padStart(12, "0");
          return `44444444-4444-4444-8444-${tail}`;
        }),
      }).success,
    ).toBe(false);
    expect(
      setProductImagesInputSchema.safeParse({
        productId,
        fileIds: [fileA, fileA],
      }).success,
    ).toBe(false);
    expect(
      setProductImagesInputSchema.safeParse({
        productId: "not-a-uuid",
        fileIds: [],
      }).success,
    ).toBe(false);
    expect(
      setProductImagesInputSchema.safeParse({
        productId,
        fileIds: ["not-a-uuid"],
      }).success,
    ).toBe(false);
  });

  it("rejects identifier fields — the input is strict", () => {
    const valid = { productId, fileIds: [fileA] };
    for (const extra of [
      { companyId: "c" },
      { userId: "u" },
      { objectKey: "k" },
      { url: "https://example.test" },
    ]) {
      expect(
        setProductImagesInputSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
    }
  });
});
