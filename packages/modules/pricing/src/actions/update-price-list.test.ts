import { describe, expect, it } from "vitest";

import { PRICE_LIST_NAME_MAX } from "./list-price-lists.contract.js";
import {
  updatePriceListContract,
  updatePriceListInputSchema,
  updatePriceListOutputSchema,
} from "./update-price-list.contract.js";

const validUpdate = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Wholesale",
};

describe("pricing.updatePriceList contract", () => {
  it("is an idempotent audited staff client write with pricing:manage and no events", () => {
    expect(updatePriceListContract.name).toBe("pricing.updatePriceList");
    expect(updatePriceListContract.principal).toBe("staff");
    expect(updatePriceListContract.transport).toBe("client");
    expect(updatePriceListContract.risk).toBe("write");
    expect(updatePriceListContract.permissions).toEqual(["pricing:manage"]);
    expect(updatePriceListContract.aiExposure).toBe("exposed");
    expect(updatePriceListContract.requiresConfirmation).toBe(false);
    expect(updatePriceListContract.idempotent).toBe(true);
    expect(updatePriceListContract.audit).toBe(true);
    expect(updatePriceListContract.emits).toEqual([]);
    expect(updatePriceListContract.atomicCalls).toEqual([]);
    expect(updatePriceListContract.atomicCallers).toEqual([]);
    expect(updatePriceListContract.timeout).toBe(5_000);
    expect(updatePriceListContract.rateLimit).toBeUndefined();
    expect(Object.keys(updatePriceListOutputSchema.shape).toSorted()).toEqual([
      "createdAt",
      "entryCount",
      "id",
      "isActive",
      "isDefault",
      "name",
      "updatedAt",
    ]);
  });

  it("trims the name and rejects blank names, over-max names, and bad ids", () => {
    expect(updatePriceListInputSchema.parse(validUpdate).name).toBe(
      "Wholesale",
    );
    expect(
      updatePriceListInputSchema.parse({
        ...validUpdate,
        name: "  Оптовий  ",
      }).name,
    ).toBe("Оптовий");
    expect(
      updatePriceListInputSchema.safeParse({ ...validUpdate, name: "   " })
        .success,
    ).toBe(false);
    expect(
      updatePriceListInputSchema.safeParse({
        ...validUpdate,
        name: "x".repeat(PRICE_LIST_NAME_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      updatePriceListInputSchema.safeParse({
        ...validUpdate,
        id: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("omits the name to keep it and refuses to clear it with null", () => {
    expect(
      updatePriceListInputSchema.safeParse({ id: validUpdate.id }),
    ).toMatchObject({ success: true });
    expect(
      updatePriceListInputSchema.safeParse({ ...validUpdate, name: null })
        .success,
    ).toBe(false);
  });

  it("rejects identifier fields and default/active flags — the input is name only", () => {
    for (const extra of [
      { companyId: "c" },
      { isDefault: true },
      { isActive: false },
      { userId: "u" },
      { entryCount: 1 },
    ]) {
      expect(
        updatePriceListInputSchema.safeParse({ ...validUpdate, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
