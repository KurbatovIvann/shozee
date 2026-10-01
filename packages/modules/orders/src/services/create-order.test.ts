import { CoreInvariantError } from "@showzy/core/errors";
import { describe, expect, it } from "vitest";

import {
  priceOrderLines,
  type PersistedCreateLine,
  type ResolvedOrderPrice,
} from "./create-order.js";

const CAKE = "11111111-1111-4111-8111-111111111111";
const BOX = "22222222-2222-4222-8222-222222222222";

function line(productId: string): PersistedCreateLine {
  return {
    productId,
    variantId: null,
    quantityMilli: "2000",
    productName: "Торт Наполеон",
    variantName: null,
  };
}

function price(productId: string): ResolvedOrderPrice {
  return {
    productId,
    variantId: null,
    unitPriceMinor: "25000",
    currency: "UAH",
    source: "base",
    sourceIds: {},
    resolverVersion: 1,
  };
}

describe("priceOrderLines", () => {
  it("prices every line from the snapshot resolved for that line", () => {
    const priced = priceOrderLines(
      [line(CAKE), line(BOX)],
      [price(CAKE), price(BOX)],
    );

    expect(priced.map((entry) => entry.item.productId)).toEqual([CAKE, BOX]);
    expect(priced.map((entry) => entry.amounts.grossAmountMinor)).toEqual([
      50_000n,
      50_000n,
    ]);
  });

  it("refuses a pricing reply with a different line count", () => {
    expect(() =>
      priceOrderLines([line(CAKE), line(BOX)], [price(CAKE)]),
    ).toThrow(CoreInvariantError);
  });

  it("refuses a pricing reply whose row does not match its line", () => {
    expect(() => priceOrderLines([line(CAKE)], [price(BOX)])).toThrow(
      CoreInvariantError,
    );
  });
});
