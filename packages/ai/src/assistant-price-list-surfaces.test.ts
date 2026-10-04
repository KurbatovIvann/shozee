import {
  getPriceListContract,
  LIST_PRICE_LIST_ENTRIES_DEFAULT_LIMIT,
  listPriceListEntriesContract,
} from "@showzy/pricing/contract";
import {
  ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
  ASSISTANT_PRICE_LISTS_SCREEN_HREF,
  assistantSurfacesFromToolResults,
  parsePriceListEntriesSurface,
  parsePriceListEntitySurfaces,
  PRICE_LIST_ENTITY_GET_TOOL,
  PRICE_LIST_ENTRIES_ENTRIES_TOOL,
  staffAssistantPresentationEnvelopesFromToolResults,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { toProviderToolName } from "./action-tool.js";
const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";
const PRODUCT_A = "3c4d5e6f-7081-49a2-8cde-f01234567890";
const VARIANT_A = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";

function entryId(index: number): string {
  return `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index).padStart(2, "0")}`;
}

function priceListOutput(overrides: Record<string, unknown> = {}): unknown {
  return getPriceListContract.output.parse({
    id: PRICE_LIST_A,
    name: "Опт",
    isDefault: false,
    isActive: true,
    entryCount: 3,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  });
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

function entriesOutput(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): unknown {
  return listPriceListEntriesContract.output.parse({ items, nextCursor });
}

describe("surface tool names are the provider names of their actions (SHO-872)", () => {
  it("binds the unfaçaded pricing reads by toProviderToolName", () => {
    expect(PRICE_LIST_ENTITY_GET_TOOL).toBe(
      toProviderToolName("pricing.getPriceList"),
    );
    expect(PRICE_LIST_ENTRIES_ENTRIES_TOOL).toBe(
      toProviderToolName("pricing.listPriceListEntries"),
    );
  });
});

describe("price-list-entity surface over the real pricing.getPriceList output (SHO-872)", () => {
  it("composes the name, markers and entry count from a contract-parsed result", () => {
    expect(
      parsePriceListEntitySurfaces([
        {
          toolName: PRICE_LIST_ENTITY_GET_TOOL,
          output: priceListOutput({ isDefault: true, name: "Основний" }),
          toolCallId: "call-price-list",
        },
      ]),
    ).toEqual([
      {
        kind: "price-list-entity",
        priceListId: PRICE_LIST_A,
        name: "Основний",
        isDefault: true,
        isActive: true,
        entryCount: 3,
        toolCallId: "call-price-list",
      },
    ]);
  });

  it("reads an absent marker flag as unknown rather than as active", () => {
    expect(
      parsePriceListEntitySurfaces([
        {
          toolName: PRICE_LIST_ENTITY_GET_TOOL,
          output: { id: PRICE_LIST_A, name: "Опт" },
        },
      ]),
    ).toEqual([
      {
        kind: "price-list-entity",
        priceListId: PRICE_LIST_A,
        name: "Опт",
        isDefault: null,
        isActive: null,
        entryCount: null,
      },
    ]);
  });

  it("composes nothing from a not-found error envelope", () => {
    expect(
      parsePriceListEntitySurfaces([
        {
          toolName: PRICE_LIST_ENTITY_GET_TOOL,
          output: { status: "error", code: "NOT_FOUND", message: "no" },
        },
      ]),
    ).toEqual([]);
  });
});

describe("price-list-entries surface over the real pricing.listPriceListEntries output (SHO-872)", () => {
  it("composes rows, the variant marker and the destination from a page", () => {
    const surface = parsePriceListEntriesSurface([
      {
        toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
        output: entriesOutput([
          entryRow(entryId(1)),
          entryRow(entryId(2), { variantId: VARIANT_A, priceMinor: "19900" }),
        ]),
      },
    ]);
    expect(surface?.kind).toBe("price-list-entries");
    expect(surface?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_PRICE_LISTS_SCREEN_HREF,
    });
    expect(surface?.rows).toEqual([
      {
        entryId: entryId(1),
        priceListId: PRICE_LIST_A,
        productId: PRODUCT_A,
        variantId: null,
        price: { amountMinor: "24500", currency: "UAH" },
      },
      {
        entryId: entryId(2),
        priceListId: PRICE_LIST_A,
        productId: PRODUCT_A,
        variantId: VARIANT_A,
        price: { amountMinor: "19900", currency: "UAH" },
      },
    ]);
    expect(surface?.hasMore).toBe(false);
    expect(surface?.collection.truncated).toBe(false);
  });

  it("caps the card below the page default so a full page is visibly truncated", () => {
    const items = Array.from(
      { length: ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX + 2 },
      (_, index) => entryRow(entryId(index + 10)),
    );
    const surface = parsePriceListEntriesSurface([
      {
        toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
        output: entriesOutput(items),
      },
    ]);
    expect(ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX).toBeLessThanOrEqual(
      LIST_PRICE_LIST_ENTRIES_DEFAULT_LIMIT,
    );
    expect(surface?.rows).toHaveLength(ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX);
    expect(surface?.collection.rowCap).toBe(
      ASSISTANT_PRICE_LIST_ENTRIES_ROW_MAX,
    );
    expect(surface?.collection.truncated).toBe(true);
    expect(surface?.hasMore).toBe(true);
  });

  it("carries a next cursor as more to come", () => {
    const surface = parsePriceListEntriesSurface([
      {
        toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
        output: entriesOutput([entryRow(entryId(1))], "next-page"),
      },
    ]);
    expect(surface?.nextCursor).toBe("next-page");
    expect(surface?.hasMore).toBe(true);
  });

  it("still shows the card for an empty page", () => {
    const surface = parsePriceListEntriesSurface([
      {
        toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
        output: entriesOutput([]),
      },
    ]);
    expect(surface?.rows).toEqual([]);
    expect(surface?.collection.truncated).toBe(false);
  });
});

describe("compose and envelopes carry both price-list surfaces (SHO-872)", () => {
  it("emits one surface per read with its own tool call id", () => {
    const results = [
      {
        toolName: PRICE_LIST_ENTRIES_ENTRIES_TOOL,
        output: entriesOutput([entryRow(entryId(1))]),
        toolCallId: "call-entries",
      },
      {
        toolName: PRICE_LIST_ENTITY_GET_TOOL,
        output: priceListOutput(),
        toolCallId: "call-price-list",
      },
    ];
    expect(
      assistantSurfacesFromToolResults(results).map((surface) => surface.kind),
    ).toEqual(["price-list-entries", "price-list-entity"]);
    expect(staffAssistantPresentationEnvelopesFromToolResults(results)).toEqual(
      [
        {
          surface: "price-list-entity",
          version: 1,
          toolCallIds: ["call-price-list"],
        },
        {
          surface: "price-list-entries",
          version: 1,
          toolCallIds: ["call-entries"],
        },
      ],
    );
  });
});
