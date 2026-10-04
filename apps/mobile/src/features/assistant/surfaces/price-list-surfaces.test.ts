import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  parsePriceListEntriesSurface,
  parsePriceListEntitySurfaces,
  PRICE_LIST_ENTITY_GET_TOOL,
  PRICE_LIST_ENTRIES_ENTRIES_TOOL,
  type AssistantPriceListEntityData,
  type AssistantPriceListEntriesData,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { pricingCopy } from "../../../i18n/pricing";
import { entryCountLabel } from "../../pricing/shared/entry-count";
import {
  priceListEditorHref,
  priceListsHref,
} from "../../pricing/shared/price-list-hrefs";
import { localizeAssistantCardPayload } from "./compose";
import { localizePriceListEntriesCard } from "./price-list-entries";
import { localizePriceListEntityCard } from "./price-list-entity";

const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";
const PRODUCT_A = "3c4d5e6f-7081-49a2-8cde-f01234567890";
const VARIANT_A = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const ENTRY_A = "cccccccc-cccc-4ccc-8ccc-cccccccccc01";
const ENTRY_B = "cccccccc-cccc-4ccc-8ccc-cccccccccc02";

function priceListEntity(
  payload: Record<string, unknown>,
): AssistantPriceListEntityData {
  const parsed = parsePriceListEntitySurfaces([
    { toolName: PRICE_LIST_ENTITY_GET_TOOL, output: payload },
  ]);
  const entity = parsed[0];
  if (entity === undefined) {
    throw new Error("price list did not compose");
  }
  return entity;
}

function entriesData(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): AssistantPriceListEntriesData {
  const parsed = parsePriceListEntriesSurface([
    {
      toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
      output: { items, nextCursor },
    },
  ]);
  if (parsed === null) {
    throw new Error("entries page did not compose");
  }
  return parsed;
}

function entryRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    priceListId: PRICE_LIST_A,
    productId: PRODUCT_A,
    variantId: null,
    priceMinor: "24500",
    currency: "UAH",
    ...overrides,
  };
}

describe("price-list-entity card (SHO-872)", () => {
  it("localizes the name, the entry count and the price list editor href", () => {
    const pricing = pricingCopy("uk");
    const card = localizePriceListEntityCard(
      priceListEntity({
        id: PRICE_LIST_A,
        name: "Опт",
        isDefault: false,
        isActive: true,
        entryCount: 3,
      }),
      "uk",
    );
    expect(card.kind).toBe("price-list-entity");
    expect(card.title).toBe("Опт");
    expect(card.href).toBe(priceListEditorHref(PRICE_LIST_A));
    expect(card.detailRows).toEqual([entryCountLabel(3, "uk", pricing.prices)]);
    expect(card.statusLabel).toBeNull();
    expect(card.handoffLabel).toBe(assistantCopy("uk").cards.openPriceList);
    expect(card.destination).toEqual({
      kind: "screen",
      href: priceListEditorHref(PRICE_LIST_A),
    });
  });

  it("badges the default list and prefers the inactive marker over it", () => {
    const pricing = pricingCopy("en");
    expect(
      localizePriceListEntityCard(
        priceListEntity({
          id: PRICE_LIST_A,
          name: "Wholesale",
          isDefault: true,
          isActive: true,
          entryCount: 0,
        }),
        "en",
      ),
    ).toMatchObject({
      statusLabel: pricing.defaultBadge,
      statusTone: "success",
      handoffLabel: assistantCopy("en").cards.openPriceList,
    });
    expect(
      localizePriceListEntityCard(
        priceListEntity({
          id: PRICE_LIST_A,
          name: "Wholesale",
          isDefault: true,
          isActive: false,
          entryCount: 0,
        }),
        "en",
      ),
    ).toMatchObject({
      statusLabel: pricing.inactiveBadge,
      statusTone: "attention",
    });
  });

  it("falls back to the id when the payload carries no name", () => {
    const card = localizePriceListEntityCard(
      priceListEntity({ id: PRICE_LIST_A }),
      "uk",
    );
    expect(card.title).toBe(PRICE_LIST_A);
    expect(card.detailRows).toEqual([]);
  });
});

describe("price-list-entries card (SHO-872)", () => {
  it("localizes the price, the variant marker and the editor href of its list", () => {
    const card = localizePriceListEntriesCard(
      entriesData([
        entryRow(ENTRY_A),
        entryRow(ENTRY_B, { variantId: VARIANT_A, priceMinor: "19900" }),
      ]),
      "uk",
    );
    const chrome = sharedAssistantCopy("uk").priceListEntries;
    expect(card.kind).toBe("price-list-entries");
    expect(card.rows).toEqual([
      {
        entryId: ENTRY_A,
        href: priceListEditorHref(PRICE_LIST_A),
        productId: PRODUCT_A,
        badgeLabel: null,
        badgeTone: "neutral",
        priceLabel: card.rows[0]?.priceLabel ?? null,
      },
      {
        entryId: ENTRY_B,
        href: priceListEditorHref(PRICE_LIST_A),
        productId: PRODUCT_A,
        badgeLabel: chrome.variantRow,
        badgeTone: "focus",
        priceLabel: card.rows[1]?.priceLabel ?? null,
      },
    ]);
    expect(card.rows[0]?.priceLabel).toContain("245");
    expect(card.rows[1]?.priceLabel).toContain("199");
    expect(card.collection.rows[0]?.title).toBe(PRODUCT_A);
    expect(card.collection.rows[1]?.cells).toEqual([card.rows[1]?.priceLabel]);
    expect(card.emptyTitle).toBeNull();
    expect(card.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    });
  });

  it("names the empty state and the clipped footnote per locale", () => {
    for (const locale of ["uk", "en"] satisfies readonly Locale[]) {
      const chrome = sharedAssistantCopy(locale).priceListEntries;
      const card = localizePriceListEntriesCard(entriesData([]), locale);
      expect(card.emptyTitle).toBe(chrome.listEmptyTitle);
      expect(card.emptyDescription).toBe(chrome.listEmptyDescription);
      expect(card.handoffLabel).toBe(chrome.openList);
      expect(card.footnotes).toEqual([]);
    }
  });

  it("offers the price lists screen when the page has more to come", () => {
    const card = localizePriceListEntriesCard(
      entriesData([entryRow(ENTRY_A)], "next-page"),
      "en",
    );
    expect(card.ctaHref).toBeNull();
    expect(card.ctaLabel).toBeNull();
    expect(card.collection.truncated).toBe(true);
  });

  it("falls back to the price lists screen when a row carries no list id", () => {
    const card = localizePriceListEntriesCard(
      entriesData([
        {
          id: ENTRY_A,
          productId: PRODUCT_A,
          variantId: null,
          priceMinor: "100",
          currency: "UAH",
        },
      ]),
      "en",
    );
    expect(card.rows[0]?.href).toBe(priceListsHref());
  });
});

describe("stored price-list card payloads localize through compose (SHO-872)", () => {
  it("rebuilds both kinds from what the server stored", () => {
    const entity = priceListEntity({
      id: PRICE_LIST_A,
      name: "Опт",
      isDefault: false,
      isActive: true,
      entryCount: 3,
    });
    const entries = entriesData([entryRow(ENTRY_A)]);
    expect(
      localizeAssistantCardPayload("price-list-entity", entity, "uk"),
    ).toEqual(localizePriceListEntityCard(entity, "uk"));
    expect(
      localizeAssistantCardPayload("price-list-entries", entries, "uk"),
    ).toEqual(localizePriceListEntriesCard(entries, "uk"));
  });
});
