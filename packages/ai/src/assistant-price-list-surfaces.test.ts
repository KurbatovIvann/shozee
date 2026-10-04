import { getPriceListContract } from "@showzy/pricing/contract";
import {
  assistantSurfacesFromToolResults,
  parsePriceListEntitySurfaces,
  PRICE_LIST_ENTITY_GET_TOOL,
  staffAssistantPresentationEnvelopesFromToolResults,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { toProviderToolName } from "./action-tool.js";

const PRICE_LIST_A = "5e6f7081-92a3-4bc4-8ef0-123456789012";

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

describe("the surface tool name is the provider name of its action (SHO-872)", () => {
  it("binds the unfaçaded pricing.getPriceList by toProviderToolName", () => {
    expect(PRICE_LIST_ENTITY_GET_TOOL).toBe(
      toProviderToolName("pricing.getPriceList"),
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

  it("keeps one card per price list read in the same turn", () => {
    const other = "6f708192-a3b4-4cd5-9f01-234567890123";
    const results = [
      {
        toolName: PRICE_LIST_ENTITY_GET_TOOL,
        output: priceListOutput(),
        toolCallId: "call-a",
      },
      {
        toolName: PRICE_LIST_ENTITY_GET_TOOL,
        output: priceListOutput({ id: other, name: "Роздріб" }),
        toolCallId: "call-b",
      },
    ];
    expect(
      assistantSurfacesFromToolResults(results).map((surface) => surface.kind),
    ).toEqual(["price-list-entity", "price-list-entity"]);
    expect(staffAssistantPresentationEnvelopesFromToolResults(results)).toEqual(
      [
        {
          surface: "price-list-entity",
          version: 1,
          toolCallIds: ["call-a", "call-b"],
        },
      ],
    );
  });
});
