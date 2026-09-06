import { defineActionContract } from "@showzy/core/contract";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "../clip-tool-result.js";
import {
  CATALOG_LIST_PRODUCTS_ACTION_NAME,
  CATALOG_LIST_PRODUCTS_CURSOR_MAX,
  CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT,
  CATALOG_LIST_PRODUCTS_MAX_LIMIT,
  CATALOG_LIST_PRODUCTS_QUERY_MAX,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  catalogListProductsFacadeTools,
  catalogListProductsInputSchema,
  mapCatalogListProductsInput,
  mapCatalogListProductsOutput,
} from "./catalog-list-products.js";

const listProducts = defineActionContract({
  name: "catalog.listProducts",
  description: "List products in the staff member's active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["products:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: false,
  timeout: 5_000,
  input: z.looseObject({}),
  output: z.object({
    items: z.array(z.object({ id: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fatProductRow(index: number, name = `Product ${String(index)}`) {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
    name,
    basePriceMinor: String(10_000 + index),
    currency: "UAH",
    status: "active" as const,
    variantCount: index % 4,
    primaryImageFileId: imageId,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  };
}

function compactProductRow(index: number, name = `Product ${String(index)}`) {
  const row = fatProductRow(index, name);
  return {
    id: row.id,
    name: row.name,
    basePriceMinor: row.basePriceMinor,
    currency: row.currency,
    status: row.status,
    variantCount: row.variantCount,
  };
}

describe("mapCatalogListProductsInput", () => {
  it("defaults status to active and limit to 20", () => {
    const parsed = catalogListProductsInputSchema.parse({});
    expect(mapCatalogListProductsInput(parsed)).toEqual({
      status: "active",
      limit: CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT,
    });
  });

  it("maps status, trimmed query, limit, and cursor onto canonical input", () => {
    const parsed = catalogListProductsInputSchema.parse({
      status: "all",
      query: "  Seed  ",
      limit: 50,
      cursor: "c".repeat(CATALOG_LIST_PRODUCTS_CURSOR_MAX),
    });
    expect(mapCatalogListProductsInput(parsed)).toEqual({
      status: "all",
      query: "Seed",
      limit: 50,
      cursor: "c".repeat(CATALOG_LIST_PRODUCTS_CURSOR_MAX),
    });
  });
});

describe("mapCatalogListProductsOutput", () => {
  it("keeps prices and drops image ids and timestamps", () => {
    const mapped = mapCatalogListProductsOutput({
      items: [fatProductRow(1, "Seed")],
      nextCursor: "cursor-1",
    });
    expect(mapped).toEqual({
      items: [compactProductRow(1, "Seed")],
      nextCursor: "cursor-1",
    });
    expect(JSON.stringify(mapped)).not.toContain("primaryImageFileId");
    expect(JSON.stringify(mapped)).not.toContain("createdAt");
    expect(JSON.stringify(mapped)).not.toContain("updatedAt");
    expect(JSON.stringify(mapped)).toContain("basePriceMinor");
    expect(JSON.stringify(mapped)).toContain("UAH");
  });

  it("passes typed errors through unchanged", () => {
    const error = {
      status: "error",
      code: "NOT_FOUND",
      message: "Product not found.",
    };
    expect(mapCatalogListProductsOutput(error)).toBe(error);
  });
});

describe("catalogListProductsFacadeTools", () => {
  it("executes catalog.listProducts with mapped canonical input and toolCallId", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [fatProductRow(1, "Seed")],
        nextCursor: null,
      }),
    );
    const tools = catalogListProductsFacadeTools(listProducts, execute);
    const executeTool = tools[CATALOG_LIST_PRODUCTS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { query: "Seed", status: "active", limit: 20 },
      { toolCallId: "call-catalog", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      CATALOG_LIST_PRODUCTS_ACTION_NAME,
      {
        status: "active",
        query: "Seed",
        limit: 20,
      },
      { toolCallId: "call-catalog" },
    );
    expect(result).toEqual({
      items: [compactProductRow(1, "Seed")],
      nextCursor: null,
    });
  });

  it("exposes object JSON Schema type without the Anthropic union patch", async () => {
    const tools = catalogListProductsFacadeTools(listProducts, () =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const json = await asSchema(
      tools[CATALOG_LIST_PRODUCTS_TOOL_NAME]?.inputSchema,
    ).jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  it("duplicates list caps and rejects overlong query, cursor, or limit", () => {
    expect(CATALOG_LIST_PRODUCTS_DEFAULT_LIMIT).toBe(20);
    expect(CATALOG_LIST_PRODUCTS_MAX_LIMIT).toBe(50);
    expect(CATALOG_LIST_PRODUCTS_QUERY_MAX).toBe(100);
    expect(CATALOG_LIST_PRODUCTS_CURSOR_MAX).toBe(80);
    expect(
      catalogListProductsInputSchema.safeParse({
        query: "q".repeat(CATALOG_LIST_PRODUCTS_QUERY_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      catalogListProductsInputSchema.safeParse({
        cursor: "c".repeat(CATALOG_LIST_PRODUCTS_CURSOR_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      catalogListProductsInputSchema.safeParse({
        limit: CATALOG_LIST_PRODUCTS_MAX_LIMIT + 1,
      }).success,
    ).toBe(false);
  });
});

describe("compact catalog.listProducts clip envelope", () => {
  it("does not clip a 7-product compact page", () => {
    const page = {
      items: Array.from({ length: 7 }, (_, index) => compactProductRow(index)),
      nextCursor: null,
    };
    expect(JSON.stringify(page).length).toBeLessThan(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
    expect(clipStaffAssistantToolResult(page)).toBe(page);
  });

  it("keeps basePriceMinor and currency on a 50-row compact page after clip", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      ...compactProductRow(index, `N${"x".repeat(118)}`),
      notes: "n".repeat(400),
    }));
    const page = { items, nextCursor: null };
    const serialized = JSON.stringify(page);
    expect(serialized.length).toBeGreaterThan(STAFF_ASSISTANT_CLIP_JSON_MAX);
    const clipped = clipStaffAssistantToolResult(page);
    expect(clipped).not.toBe(page);
    expect(JSON.stringify(clipped)).toContain("basePriceMinor");
    expect(JSON.stringify(clipped)).toContain("UAH");
    expect(JSON.stringify(clipped)).toContain(items[0]?.id);
    expect(
      typeof clipped === "object" &&
        clipped !== null &&
        "status" in clipped &&
        clipped.status === STAFF_ASSISTANT_CLIPPED_STATUS,
    ).toBe(true);
  });
});

describe("fat vs compact catalog rows", () => {
  it("omits image ids from the mapped page that includes productId-shaped rows", () => {
    const mapped = mapCatalogListProductsOutput({
      items: [
        {
          ...fatProductRow(0, "Seed"),
          id: productId,
        },
      ],
      nextCursor: null,
    });
    expect(mapped).toEqual({
      items: [
        {
          ...compactProductRow(0, "Seed"),
          id: productId,
        },
      ],
      nextCursor: null,
    });
  });
});
