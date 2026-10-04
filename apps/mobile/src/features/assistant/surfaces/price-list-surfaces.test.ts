import {
  parsePriceListEntitySurfaces,
  PRICE_LIST_ENTITY_GET_TOOL,
  type AssistantPriceListEntityData,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { assistantCopy } from "../../../i18n/assistant";
import { pricingCopy } from "../../../i18n/pricing";
import { entryCountLabel } from "../../pricing/shared/entry-count";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";
import { localizeAssistantCardPayload } from "./compose";
import { localizePriceListEntityCard } from "./price-list-entity";

const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";

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
      detailRows: [entryCountLabel(0, "en", pricing.prices)],
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

  it("falls back to the id when the payload carries no name or count", () => {
    const card = localizePriceListEntityCard(
      priceListEntity({ id: PRICE_LIST_A }),
      "uk",
    );
    expect(card.title).toBe(PRICE_LIST_A);
    expect(card.detailRows).toEqual([]);
    expect(card.statusLabel).toBeNull();
  });
});

describe("a stored price-list card payload localizes through compose (SHO-872)", () => {
  it("rebuilds the entity card from what the server stored", () => {
    const entity = priceListEntity({
      id: PRICE_LIST_A,
      name: "Опт",
      isDefault: false,
      isActive: true,
      entryCount: 3,
    });
    expect(
      localizeAssistantCardPayload("price-list-entity", entity, "uk"),
    ).toEqual(localizePriceListEntityCard(entity, "uk"));
  });
});
