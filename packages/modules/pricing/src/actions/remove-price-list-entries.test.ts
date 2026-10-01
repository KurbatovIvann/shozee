import { describe, expect, it } from "vitest";

import {
  REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS,
  removePriceListEntriesContract,
  removePriceListEntriesInputSchema,
  removePriceListEntriesOutputSchema,
} from "./remove-price-list-entries.contract.js";

const priceListId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";

function productIdAt(index: number): string {
  return `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
}

describe("pricing.removePriceListEntries contract", () => {
  it("is an idempotent audited staff client write with pricing:manage and no events", () => {
    expect(removePriceListEntriesContract.name).toBe(
      "pricing.removePriceListEntries",
    );
    expect(removePriceListEntriesContract.principal).toBe("staff");
    expect(removePriceListEntriesContract.transport).toBe("client");
    expect(removePriceListEntriesContract.risk).toBe("write");
    expect(removePriceListEntriesContract.permissions).toEqual([
      "pricing:manage",
    ]);
    expect(removePriceListEntriesContract.aiExposure).toBe("exposed");
    expect(removePriceListEntriesContract.requiresConfirmation).toBe(false);
    expect(removePriceListEntriesContract.idempotent).toBe(true);
    expect(removePriceListEntriesContract.audit).toBe(true);
    expect(removePriceListEntriesContract.emits).toEqual([]);
    expect(removePriceListEntriesContract.atomicCalls).toEqual([]);
    expect(removePriceListEntriesContract.atomicCallers).toEqual([]);
    expect(removePriceListEntriesContract.timeout).toBe(10_000);
    expect(removePriceListEntriesContract.rateLimit).toBeUndefined();
    expect(REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS).toBe(200);
    expect(
      Object.keys(removePriceListEntriesOutputSchema.shape).toSorted(),
    ).toEqual(["priceListId"]);
  });

  it("accepts product-level and variant-level keys and rejects empty or oversized batches", () => {
    expect(
      removePriceListEntriesInputSchema.parse({
        priceListId,
        entries: [{ productId }],
      }),
    ).toEqual({
      priceListId,
      entries: [{ productId }],
    });
    expect(
      removePriceListEntriesInputSchema.parse({
        priceListId,
        entries: [{ productId, variantId }],
      }).entries[0],
    ).toEqual({ productId, variantId });
    expect(
      removePriceListEntriesInputSchema.safeParse({
        priceListId,
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      removePriceListEntriesInputSchema.safeParse({
        priceListId,
        entries: Array.from(
          { length: REMOVE_PRICE_LIST_ENTRIES_MAX_ITEMS + 1 },
          (_, index) => ({ productId: productIdAt(index) }),
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects identifier fields — the input is strict", () => {
    const valid = { priceListId, entries: [{ productId }] };
    for (const extra of [
      { companyId: "c" },
      { id: priceListId },
      { userId: "u" },
    ]) {
      expect(
        removePriceListEntriesInputSchema.safeParse({ ...valid, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
