import { defineActionContract } from "@showzy/core/contract";
import { ConflictError, NotFoundError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CHOICE_CREATE_OPTION_ID,
  catalogPickerConflictExtrasFromError,
} from "../choice.js";
import {
  CATALOG_GET_PRODUCT_ACTION_NAME,
  CATALOG_GET_PRODUCT_TOOL_NAME,
  catalogGetProductFacadeTools,
  catalogGetProductInputSchema,
} from "./catalog-get-product.js";
import { ENTITY_LOOKUP_RECORD_OPTIONS_MAX } from "./entity-lookup.js";

const getProduct = defineActionContract({
  name: CATALOG_GET_PRODUCT_ACTION_NAME,
  description: "Read one product in the staff member's active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["catalog:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND", "CONFLICT"],
  audit: false,
  timeout: 5_000,
  input: z.strictObject({
    productId: z.uuid().optional(),
    productQuery: z.string().min(1).optional(),
  }),
  output: z.object({ id: z.uuid(), name: z.string() }),
});

const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function nearestOption(index: number): { id: string; label: string } {
  return {
    id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, "0")}`,
    label: `Наполеон ${String(index)}`,
  };
}

function unmatched(
  options: readonly { id: string; label: string }[],
): NotFoundError {
  return Object.assign(new NotFoundError('Nothing matches "наполеон".'), {
    reason: "unmatched_query",
    target: { kind: "product", query: "наполеон" },
    options,
    optionsTruncated: false,
  });
}

function runTool(
  execute: (
    actionName: string,
    input: unknown,
    options: { readonly toolCallId: string },
  ) => Promise<unknown>,
  input: unknown,
): Promise<unknown> {
  const tool = catalogGetProductFacadeTools(getProduct, execute)[
    CATALOG_GET_PRODUCT_TOOL_NAME
  ];
  const run = tool?.execute;
  if (run === undefined) {
    throw new Error("facade tool has no execute");
  }
  return Promise.resolve(
    run(input, {
      toolCallId: "call-product",
      messages: [],
      context: undefined,
    }),
  );
}

describe("catalogGetProductInputSchema", () => {
  it("refuses both references and neither reference", () => {
    expect(
      catalogGetProductInputSchema.safeParse({
        productId,
        productQuery: "наполеон",
      }).success,
    ).toBe(false);
    expect(catalogGetProductInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("catalogGetProductFacadeTools", () => {
  it("reads the product by id in one call", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ id: productId, name: "Наполеон" }),
    );
    const result = await runTool(execute, { productId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      CATALOG_GET_PRODUCT_ACTION_NAME,
      { productId },
      { toolCallId: "call-product" },
    );
    expect(result).toEqual({ id: productId, name: "Наполеон" });
  });

  it("sends a name query to the owning action in one call", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ id: productId, name: "Наполеон" }),
    );
    await runTool(execute, { productQuery: "наполеон" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      CATALOG_GET_PRODUCT_ACTION_NAME,
      { productQuery: "наполеон" },
      { toolCallId: "call-product" },
    );
  });

  it("passes the action's several-matches conflict through untouched", async () => {
    const ambiguous = Object.assign(new ConflictError("Which Наполеон?"), {
      reason: "ambiguous",
      target: { kind: "product", query: "наполеон" },
      options: [
        { id: productId, label: "Наполеон (UAH)" },
        { id: otherId, label: "Наполеон (EUR)" },
      ],
      optionsTruncated: false,
    });
    await expect(
      runTool(() => Promise.reject(ambiguous), { productQuery: "наполеон" }),
    ).rejects.toBe(ambiguous);
    const picker = catalogPickerConflictExtrasFromError(ambiguous);
    expect(picker?.target).toEqual({ kind: "product", query: "наполеон" });
    expect(picker?.options).toHaveLength(2);
    expect(picker?.create).toBeUndefined();
  });

  it("offers the action's nearest products plus create when nothing matched", async () => {
    const nearest = [nearestOption(1), nearestOption(2)];
    const error: unknown = await runTool(
      () => Promise.reject(unmatched(nearest)),
      { productQuery: "наполеон" },
    ).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker).toEqual({
      reason: "unmatched_query",
      target: { kind: "product", query: "наполеон" },
      options: nearest,
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "наполеон"' },
    });
  });

  it("leaves room for the create option when the nearest list fills the card", async () => {
    const nearest = Array.from({ length: 20 }, (_, index) =>
      nearestOption(index),
    );
    const error: unknown = await runTool(
      () => Promise.reject(unmatched(nearest)),
      { productQuery: "наполеон" },
    ).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker?.options).toHaveLength(ENTITY_LOOKUP_RECORD_OPTIONS_MAX);
    expect(picker?.optionsTruncated).toBe(true);
    expect(picker?.create).toBeDefined();
  });

  it("refuses a product id from another company with not found", async () => {
    const execute = vi.fn(() => Promise.reject(new NotFoundError()));
    await expect(runTool(execute, { productId: foreignId })).rejects.toThrow(
      NotFoundError,
    );
    expect(execute).toHaveBeenCalledWith(
      CATALOG_GET_PRODUCT_ACTION_NAME,
      { productId: foreignId },
      { toolCallId: "call-product" },
    );
  });

  it("keeps a plain not-found plain", async () => {
    const plain = new NotFoundError();
    await expect(
      runTool(() => Promise.reject(plain), { productQuery: "наполеон" }),
    ).rejects.toBe(plain);
  });

  it("tells the model a named product is this tool and a plural is the list", () => {
    const description = catalogGetProductFacadeTools(getProduct, () =>
      Promise.resolve({}),
    )[CATALOG_GET_PRODUCT_TOOL_NAME]?.description;
    expect(description).toContain("means this tool, not the list");
    expect(description).toContain("catalog_list_products");
  });
});
