import { listProductsContract } from "@showzy/catalog/contract";
import { listPriceListsContract } from "@showzy/pricing/contract";
import {
  ASSISTANT_PRICE_LISTS_ROW_MAX,
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  ASSISTANT_PRODUCTS_LIST_ROW_MAX,
  ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
  assistantSurfacesFromToolResults,
  parsePriceListsSurface,
  parseProductsListSurface,
  PRICE_LISTS_PRICE_LISTS_TOOL,
  PRODUCTS_LIST_PRODUCTS_TOOL,
  staffAssistantPresentationEnvelopesFromToolResults,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import {
  CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT,
  mapCatalogListProductsOutput,
} from "./tool-facades/catalog-list-products.js";
import {
  LIST_PRICE_LISTS_DEFAULT_LIMIT,
  mapPricingListPriceListsOutput,
} from "./tool-facades/pricing-list-price-lists.js";

const PRODUCT_A = "3c4d5e6f-7081-49a2-8cde-f01234567890";
const PRODUCT_B = "4d5e6f70-8192-4ab3-9def-012345678901";
const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";
const PRICE_LIST_B = "6f708192-a3b4-4cd5-9f01-234567890123";

function productId(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(index).padStart(2, "0")}`;
}

function priceListId(index: number): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb${String(index).padStart(2, "0")}`;
}

function productRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "Наполеон",
    basePriceMinor: "24500",
    currency: "UAH",
    status: "active",
    variantCount: 2,
    primaryImageFileId: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

function priceListRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "Опт",
    isDefault: false,
    isActive: true,
    entryCount: 3,
    ...overrides,
  };
}

function productsToolOutput(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): unknown {
  return mapCatalogListProductsOutput(
    listProductsContract.output.parse({ items, nextCursor }),
  );
}

function priceListsToolOutput(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): unknown {
  return mapPricingListPriceListsOutput(
    listPriceListsContract.output.parse({ items, nextCursor }),
  );
}

describe("products-list surface over the real catalog.listProducts output (SHO-865)", () => {
  it("composes rows, money and destination from a contract-parsed page", () => {
    const surface = parseProductsListSurface([
      {
        toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
        output: productsToolOutput([
          productRow(PRODUCT_A),
          productRow(PRODUCT_B, {
            name: "Медовик",
            status: "archived",
            variantCount: 0,
            basePriceMinor: "0",
          }),
        ]),
      },
    ]);
    expect(surface?.kind).toBe("products-list");
    expect(surface?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
    });
    expect(surface?.rows).toEqual([
      {
        productId: PRODUCT_A,
        name: "Наполеон",
        basePrice: { amountMinor: "24500", currency: "UAH" },
        status: "active",
        variantCount: 2,
      },
      {
        productId: PRODUCT_B,
        name: "Медовик",
        basePrice: { amountMinor: "0", currency: "UAH" },
        status: "archived",
        variantCount: 0,
      },
    ]);
    expect(surface?.collection.truncated).toBe(false);
    expect(surface?.hasMore).toBe(false);
  });

  it("caps the card below the façade page so a full page is visibly truncated", () => {
    const items = Array.from(
      { length: ASSISTANT_PRODUCTS_LIST_ROW_MAX + 3 },
      (_, index) => productRow(productId(index)),
    );
    const surface = parseProductsListSurface([
      {
        toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
        output: productsToolOutput(items),
      },
    ]);
    expect(ASSISTANT_PRODUCTS_LIST_ROW_MAX).toBeLessThanOrEqual(
      CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT,
    );
    expect(surface?.rows).toHaveLength(ASSISTANT_PRODUCTS_LIST_ROW_MAX);
    expect(surface?.collection.rowCap).toBe(ASSISTANT_PRODUCTS_LIST_ROW_MAX);
    expect(surface?.collection.truncated).toBe(true);
    expect(surface?.hasMore).toBe(true);
  });

  it("carries a next cursor as more to come", () => {
    const surface = parseProductsListSurface([
      {
        toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
        output: productsToolOutput([productRow(PRODUCT_A)], "next-page"),
      },
    ]);
    expect(surface?.nextCursor).toBe("next-page");
    expect(surface?.hasMore).toBe(true);
    expect(surface?.collection.truncated).toBe(true);
  });
});

describe("price-lists surface over the real pricing.listPriceLists output (SHO-865)", () => {
  it("composes rows, markers and destination from a contract-parsed page", () => {
    const surface = parsePriceListsSurface([
      {
        toolName: PRICE_LISTS_PRICE_LISTS_TOOL,
        output: priceListsToolOutput([
          priceListRow(PRICE_LIST_A, { isDefault: true, name: "Основний" }),
          priceListRow(PRICE_LIST_B, { isActive: false, entryCount: 0 }),
        ]),
      },
    ]);
    expect(surface?.kind).toBe("price-lists");
    expect(surface?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    });
    expect(surface?.rows).toEqual([
      {
        priceListId: PRICE_LIST_A,
        name: "Основний",
        isDefault: true,
        isActive: true,
        entryCount: 3,
      },
      {
        priceListId: PRICE_LIST_B,
        name: "Опт",
        isDefault: false,
        isActive: false,
        entryCount: 0,
      },
    ]);
    expect(surface?.collection.truncated).toBe(false);
  });

  it("reads an absent marker flag as unknown rather than as active", () => {
    const surface = parsePriceListsSurface([
      {
        toolName: PRICE_LISTS_PRICE_LISTS_TOOL,
        output: {
          items: [{ id: PRICE_LIST_A, name: "Опт", entryCount: 3 }],
          nextCursor: null,
        },
      },
    ]);
    expect(surface?.rows).toEqual([
      {
        priceListId: PRICE_LIST_A,
        name: "Опт",
        isDefault: null,
        isActive: null,
        entryCount: 3,
      },
    ]);
  });

  it("caps the card below the façade page so a full page is visibly truncated", () => {
    const items = Array.from(
      { length: ASSISTANT_PRICE_LISTS_ROW_MAX + 2 },
      (_, index) => priceListRow(priceListId(index)),
    );
    const surface = parsePriceListsSurface([
      {
        toolName: PRICE_LISTS_PRICE_LISTS_TOOL,
        output: priceListsToolOutput(items),
      },
    ]);
    expect(ASSISTANT_PRICE_LISTS_ROW_MAX).toBeLessThanOrEqual(
      LIST_PRICE_LISTS_DEFAULT_LIMIT,
    );
    expect(surface?.rows).toHaveLength(ASSISTANT_PRICE_LISTS_ROW_MAX);
    expect(surface?.collection.truncated).toBe(true);
    expect(surface?.hasMore).toBe(true);
  });
});

describe("compose and envelopes carry both new lists (SHO-865)", () => {
  it("emits one surface per list with its own tool call id", () => {
    const results = [
      {
        toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
        output: productsToolOutput([productRow(PRODUCT_A)]),
        toolCallId: "call-products",
      },
      {
        toolName: PRICE_LISTS_PRICE_LISTS_TOOL,
        output: priceListsToolOutput([priceListRow(PRICE_LIST_A)]),
        toolCallId: "call-price-lists",
      },
    ];
    expect(
      assistantSurfacesFromToolResults(results).map((surface) => surface.kind),
    ).toEqual(["products-list", "price-lists"]);
    expect(staffAssistantPresentationEnvelopesFromToolResults(results)).toEqual(
      [
        {
          surface: "products-list",
          version: 1,
          toolCallIds: ["call-products"],
        },
        {
          surface: "price-lists",
          version: 1,
          toolCallIds: ["call-price-lists"],
        },
      ],
    );
  });

  it("composes nothing from an empty page but still shows the card", () => {
    const surface = parseProductsListSurface([
      {
        toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
        output: productsToolOutput([]),
      },
    ]);
    expect(surface?.rows).toEqual([]);
    expect(surface?.collection.truncated).toBe(false);
  });
});
