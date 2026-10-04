import {
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
  parsePriceListsSurface,
  parseProductsListSurface,
  PRICE_LISTS_PRICE_LISTS_TOOL,
  PRODUCTS_LIST_PRODUCTS_TOOL,
  type AssistantPriceListsData,
  type AssistantProductsListData,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { pricingCopy } from "../../../i18n/pricing";
import { productsCopy } from "../../../i18n/products";
import { productEditorHref } from "../../catalog/products/shared/product-hrefs";
import { variantCountLabel } from "../../catalog/products/shared/variant-count";
import { entryCountLabel } from "../../pricing/shared/entry-count";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";
import { localizeAssistantCardPayload } from "./compose";
import { localizePriceListsCard } from "./price-lists";
import { localizeProductsListCard } from "./products-list";

const PRODUCT_A = "3c4d5e6f-7081-49a2-8cde-f01234567890";
const PRODUCT_B = "4d5e6f70-8192-4ab3-9def-012345678901";
const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";
const PRICE_LIST_B = "6f708192-a3b4-4cd5-9f01-234567890123";

function productsData(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): AssistantProductsListData {
  const parsed = parseProductsListSurface([
    {
      toolName: PRODUCTS_LIST_PRODUCTS_TOOL,
      output: { items, nextCursor },
    },
  ]);
  if (parsed === null) {
    throw new Error("products page did not compose");
  }
  return parsed;
}

function priceListsData(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): AssistantPriceListsData {
  const parsed = parsePriceListsSurface([
    {
      toolName: PRICE_LISTS_PRICE_LISTS_TOOL,
      output: { items, nextCursor },
    },
  ]);
  if (parsed === null) {
    throw new Error("price lists page did not compose");
  }
  return parsed;
}

describe("products-list card (SHO-865)", () => {
  const products = productsCopy("uk");

  it("localizes name, price, variants and the product editor href", () => {
    const card = localizeProductsListCard(
      productsData([
        {
          id: PRODUCT_A,
          name: "Наполеон",
          basePriceMinor: "24500",
          currency: "UAH",
          status: "active",
          variantCount: 2,
        },
      ]),
      "uk",
    );
    expect(card.kind).toBe("products-list");
    expect(card.rows).toEqual([
      {
        productId: PRODUCT_A,
        href: productEditorHref(PRODUCT_A),
        name: "Наполеон",
        statusLabel: null,
        statusTone: "neutral",
        metaLabel: variantCountLabel(2, "uk", products.variants),
        basePriceLabel: card.rows[0]?.basePriceLabel ?? null,
      },
    ]);
    expect(card.rows[0]?.basePriceLabel).toContain("245");
    expect(card.collection.rows[0]?.cells).toEqual([
      card.rows[0]?.basePriceLabel,
    ]);
    expect(card.emptyTitle).toBeNull();
    expect(card.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
    });
  });

  it("badges an archived product and keeps the badge label mandatory", () => {
    const card = localizeProductsListCard(
      productsData([
        {
          id: PRODUCT_B,
          name: "Медовик",
          basePriceMinor: "1000",
          currency: "UAH",
          status: "archived",
          variantCount: 0,
        },
      ]),
      "uk",
    );
    expect(card.rows[0]?.statusLabel).toBe(products.archivedBadge);
    expect(card.rows[0]?.statusTone).toBe("attention");
    expect(card.collection.rows[0]?.badge).toBe(products.archivedBadge);
  });

  it("leaves the products handoff to the frame instead of a second CTA", () => {
    const empty = localizeProductsListCard(productsData([]), "uk");
    expect(empty.emptyTitle).not.toBeNull();
    expect(empty.ctaHref).toBeNull();

    const more = localizeProductsListCard(
      productsData(
        [
          {
            id: PRODUCT_A,
            name: "Наполеон",
            basePriceMinor: "24500",
            currency: "UAH",
            status: "active",
            variantCount: 1,
          },
        ],
        "next-page",
      ),
      "uk",
    );
    expect(more.ctaHref).toBeNull();
    expect(more.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRODUCTS_LIST_SCREEN_HREF,
    });
    expect(more.handoffLabel.length).toBeGreaterThan(0);
  });

  it("localizes the same payload in both languages", () => {
    const data = productsData([
      {
        id: PRODUCT_A,
        name: "Наполеон",
        basePriceMinor: "24500",
        currency: "UAH",
        status: "archived",
        variantCount: 1,
      },
    ]);
    expect(localizeProductsListCard(data, "en").rows[0]?.statusLabel).toBe(
      productsCopy("en").archivedBadge,
    );
    expect(localizeProductsListCard(data, "uk").rows[0]?.statusLabel).toBe(
      products.archivedBadge,
    );
  });
});

describe("price-lists card (SHO-865)", () => {
  const pricing = pricingCopy("uk");

  it("localizes the default marker, entry count and the editor href", () => {
    const card = localizePriceListsCard(
      priceListsData([
        {
          id: PRICE_LIST_A,
          name: "Основний",
          isDefault: true,
          isActive: true,
          entryCount: 3,
        },
      ]),
      "uk",
    );
    expect(card.kind).toBe("price-lists");
    expect(card.rows).toEqual([
      {
        priceListId: PRICE_LIST_A,
        href: priceListEditorHref(PRICE_LIST_A),
        name: "Основний",
        badgeLabel: pricing.defaultBadge,
        badgeTone: "success",
        metaLabel: entryCountLabel(3, "uk", pricing.prices),
      },
    ]);
    expect(card.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    });
  });

  it("prefers the inactive marker over the default one", () => {
    const card = localizePriceListsCard(
      priceListsData([
        {
          id: PRICE_LIST_B,
          name: "Опт",
          isDefault: true,
          isActive: false,
          entryCount: 0,
        },
      ]),
      "uk",
    );
    expect(card.rows[0]?.badgeLabel).toBe(pricing.inactiveBadge);
    expect(card.rows[0]?.badgeTone).toBe("attention");
    expect(card.rows[0]?.metaLabel).toBe(
      entryCountLabel(0, "uk", pricing.prices),
    );
  });

  it("shows no marker when the row carries no marker flags", () => {
    const card = localizePriceListsCard(
      priceListsData([{ id: PRICE_LIST_B, name: "Опт", entryCount: 2 }]),
      "uk",
    );
    expect(card.rows[0]?.badgeLabel).toBeNull();
    expect(card.rows[0]?.badgeTone).toBe("neutral");
  });

  it("shows the empty card when the company has no price lists", () => {
    const card = localizePriceListsCard(priceListsData([]), "en");
    expect(card.rows).toEqual([]);
    expect(card.emptyTitle).toBe("No price lists");
    expect(card.collection.rows).toEqual([]);
  });
});

describe("stored card payloads localize for both new kinds (SHO-865)", () => {
  it("routes products-list and price-lists through the registry", () => {
    const products = productsData([
      {
        id: PRODUCT_A,
        name: "Наполеон",
        basePriceMinor: "24500",
        currency: "UAH",
        status: "active",
        variantCount: 1,
      },
    ]);
    const priceLists = priceListsData([
      {
        id: PRICE_LIST_A,
        name: "Основний",
        isDefault: true,
        isActive: true,
        entryCount: 1,
      },
    ]);
    expect(
      localizeAssistantCardPayload("products-list", products, "uk")?.kind,
    ).toBe("products-list");
    expect(
      localizeAssistantCardPayload("price-lists", priceLists, "uk")?.kind,
    ).toBe("price-lists");
    expect(localizeAssistantCardPayload("price-lists", products, "uk")).toBe(
      null,
    );
  });
});
