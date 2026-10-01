import { describe, expect, it } from "vitest";

import {
  LIST_NAME_INDEX_PRODUCTS_MAX,
  LIST_NAME_INDEX_VARIANTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

describe("catalog.listNameIndex contract", () => {
  it("is a staff internal read with products:view", () => {
    expect(listNameIndexContract.name).toBe("catalog.listNameIndex");
    expect(listNameIndexContract.principal).toBe("staff");
    expect(listNameIndexContract.transport).toBe("internal");
    expect(listNameIndexContract.risk).toBe("read");
    expect(listNameIndexContract.permissions).toEqual(["products:view"]);
    expect(listNameIndexContract.aiExposure).toBe("internal");
    expect(listNameIndexContract.audit).toBe(false);
    expect(listNameIndexContract.idempotent).toBe(false);
    expect(listNameIndexContract.requiresConfirmation).toBe(false);
    expect(listNameIndexContract.emits).toEqual([]);
    expect(listNameIndexContract.timeout).toBe(5_000);
    expect(LIST_NAME_INDEX_PRODUCTS_MAX).toBe(20_000);
    expect(LIST_NAME_INDEX_VARIANTS_MAX).toBe(100_000);
  });

  it("takes no input and rejects a tenant identifier", () => {
    expect(listNameIndexContract.input.parse({})).toEqual({});
    expect(
      listNameIndexContract.input.safeParse({
        companyId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });

  it("carries ids and names only, with productId on a variant", () => {
    const parsed = listNameIndexContract.output.parse({
      products: {
        items: [{ id: "11111111-1111-4111-8111-111111111111", name: "Кава" }],
        truncated: false,
      },
      variants: {
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            productId: "11111111-1111-4111-8111-111111111111",
            name: "Кава / 1 кг",
          },
        ],
        truncated: false,
      },
    });
    expect(Object.keys(parsed.products.items[0] ?? {}).sort()).toEqual([
      "id",
      "name",
    ]);
    expect(Object.keys(parsed.variants.items[0] ?? {}).sort()).toEqual([
      "id",
      "name",
      "productId",
    ]);
    expect(
      listNameIndexContract.output.safeParse({
        products: {
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Кава",
              basePriceMinor: 1000,
            },
          ],
          truncated: false,
        },
        variants: { items: [], truncated: false },
      }).success,
    ).toBe(false);
  });
});
