import { defineActionContract } from "@showzy/core/contract";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  LIST_PRICE_LISTS_CURSOR_MAX,
  LIST_PRICE_LISTS_DEFAULT_LIMIT,
  LIST_PRICE_LISTS_MAX_LIMIT,
  LIST_PRICE_LISTS_QUERY_MAX,
  mapPricingListPriceListsInput,
  mapPricingListPriceListsOutput,
  PRICING_CREATE_PRICE_LIST_DESCRIPTION_SUFFIX,
  PRICING_LIST_PRICE_LISTS_ACTION_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  PRICING_SET_PRICE_LIST_ENTRIES_DESCRIPTION_SUFFIX,
  pricingListPriceListsFacadeTools,
  pricingListPriceListsInputSchema,
} from "./pricing-list-price-lists.js";

const listPriceLists = defineActionContract({
  name: "pricing.listPriceLists",
  description: "List price lists in the staff member's active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["pricing:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
  input: z.object({
    query: z.string().trim().min(1).max(LIST_PRICE_LISTS_QUERY_MAX).optional(),
    availability: z.enum(["all", "active", "inactive"]).default("all"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_PRICE_LISTS_MAX_LIMIT)
      .default(LIST_PRICE_LISTS_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(LIST_PRICE_LISTS_CURSOR_MAX).optional(),
  }),
  output: z.object({
    items: z.array(z.object({ id: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

const listId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fatPriceListRow(name = "Opt") {
  return {
    id: listId,
    name,
    isDefault: false,
    isActive: true,
    entryCount: 3,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  };
}

function compactPriceListRow(name = "Opt") {
  return {
    id: listId,
    name,
    isDefault: false,
    isActive: true,
    entryCount: 3,
  };
}

describe("mapPricingListPriceListsInput", () => {
  it("defaults limit to 20 and omits availability", () => {
    const parsed = pricingListPriceListsInputSchema.parse({});
    expect(mapPricingListPriceListsInput(parsed)).toEqual({
      limit: LIST_PRICE_LISTS_DEFAULT_LIMIT,
    });
  });

  it("maps trimmed query, limit, and cursor onto canonical input", () => {
    const parsed = pricingListPriceListsInputSchema.parse({
      query: "  Opt  ",
      limit: 50,
      cursor: "c".repeat(LIST_PRICE_LISTS_CURSOR_MAX),
    });
    expect(mapPricingListPriceListsInput(parsed)).toEqual({
      query: "Opt",
      limit: 50,
      cursor: "c".repeat(LIST_PRICE_LISTS_CURSOR_MAX),
    });
  });
});

describe("mapPricingListPriceListsOutput", () => {
  it("keeps entryCount and drops timestamps", () => {
    const mapped = mapPricingListPriceListsOutput({
      items: [fatPriceListRow()],
      nextCursor: "cursor-1",
    });
    expect(mapped).toEqual({
      items: [compactPriceListRow()],
      nextCursor: "cursor-1",
    });
    expect(JSON.stringify(mapped)).not.toContain("createdAt");
    expect(JSON.stringify(mapped)).not.toContain("updatedAt");
    expect(JSON.stringify(mapped)).toContain("entryCount");
  });

  it("passes typed errors through unchanged", () => {
    const error = {
      status: "error",
      code: "NOT_FOUND",
      message: "Price list not found.",
    };
    expect(mapPricingListPriceListsOutput(error)).toBe(error);
  });
});

describe("pricingListPriceListsFacadeTools", () => {
  it("executes pricing.listPriceLists with mapped canonical input and toolCallId", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [fatPriceListRow()],
        nextCursor: null,
      }),
    );
    const tools = pricingListPriceListsFacadeTools(listPriceLists, execute);
    const executeTool = tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { query: "Opt", limit: 20 },
      { toolCallId: "call-pricing", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      PRICING_LIST_PRICE_LISTS_ACTION_NAME,
      {
        query: "Opt",
        availability: "all",
        limit: 20,
      },
      { toolCallId: "call-pricing" },
    );
    expect(result).toEqual({
      items: [compactPriceListRow()],
      nextCursor: null,
    });
  });

  it("fills availability all and limit 20 via contract.input.parse", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const tools = pricingListPriceListsFacadeTools(listPriceLists, execute);
    const executeTool = tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    await executeTool(
      {},
      { toolCallId: "call-defaults", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      PRICING_LIST_PRICE_LISTS_ACTION_NAME,
      { availability: "all", limit: LIST_PRICE_LISTS_DEFAULT_LIMIT },
      { toolCallId: "call-defaults" },
    );
  });

  it("exposes object JSON Schema type without the Anthropic union patch", async () => {
    const tools = pricingListPriceListsFacadeTools(listPriceLists, () =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const json = await asSchema(
      tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.inputSchema,
    ).jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  it("duplicates list caps and rejects overlong query, cursor, or limit", () => {
    expect(LIST_PRICE_LISTS_DEFAULT_LIMIT).toBe(20);
    expect(LIST_PRICE_LISTS_MAX_LIMIT).toBe(50);
    expect(LIST_PRICE_LISTS_QUERY_MAX).toBe(100);
    expect(LIST_PRICE_LISTS_CURSOR_MAX).toBe(200);
    expect(
      pricingListPriceListsInputSchema.safeParse({
        query: "q".repeat(LIST_PRICE_LISTS_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      pricingListPriceListsInputSchema.safeParse({
        cursor: "c".repeat(LIST_PRICE_LISTS_CURSOR_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      pricingListPriceListsInputSchema.safeParse({
        limit: LIST_PRICE_LISTS_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
  });

  it("tells the model to find by name before create and fill after catalog prices", () => {
    const tools = pricingListPriceListsFacadeTools(listPriceLists, () =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    expect(tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.description).toContain(
      "Find a list by name with this tool before creating a duplicate",
    );
    expect(tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.description).toContain(
      "pricing.setPriceListEntries",
    );
    expect(tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.description).toContain(
      "catalog_list_products",
    );
    expect(PRICING_CREATE_PRICE_LIST_DESCRIPTION_SUFFIX).toContain(
      "pricing_list_price_lists",
    );
    expect(PRICING_SET_PRICE_LIST_ENTRIES_DESCRIPTION_SUFFIX).toContain(
      "catalog_list_products",
    );
  });
});
