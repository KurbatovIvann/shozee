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
  CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME,
  catalogGetProductFacadeTools,
  catalogGetProductInputSchema,
} from "./catalog-get-product.js";

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
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 5_000,
  input: z.strictObject({ productId: z.uuid() }),
  output: z.object({ id: z.uuid(), name: z.string() }),
});

const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
        productQuery: "Наполеон",
      }).success,
    ).toBe(false);
    expect(catalogGetProductInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("catalogGetProductFacadeTools", () => {
  it("reads the product by id without resolving a reference", async () => {
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

  it("resolves a unique name query through the line resolver", async () => {
    const execute = vi.fn((actionName: string) =>
      actionName === CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME
        ? Promise.resolve({ lines: [{ productId }] })
        : Promise.resolve({ id: productId, name: "Наполеон" }),
    );
    const result = await runTool(execute, { productQuery: "Наполеон" });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME,
      { lines: [{ product: { by: "query", value: "Наполеон" } }] },
      { toolCallId: "call-product" },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      CATALOG_GET_PRODUCT_ACTION_NAME,
      { productId },
      { toolCallId: "call-product" },
    );
    expect(result).toEqual({ id: productId, name: "Наполеон" });
  });

  it("re-targets several matches from an order line onto the product query", async () => {
    const ambiguous = Object.assign(new ConflictError("Which Наполеон?"), {
      reason: "ambiguous",
      target: { kind: "order_line_product", lineIndex: 0, query: "Наполеон" },
      options: [
        { id: productId, label: "Наполеон класичний" },
        { id: otherId, label: "Наполеон медовий" },
      ],
      optionsTruncated: false,
    });
    const error: unknown = await runTool(() => Promise.reject(ambiguous), {
      productQuery: "Наполеон",
    }).catch((thrown: unknown) => thrown);
    const picker = catalogPickerConflictExtrasFromError(error);
    expect(picker?.target).toEqual({ kind: "product", query: "Наполеон" });
    expect(picker?.options).toHaveLength(2);
    expect(picker?.create).toBeUndefined();
  });

  it("reads the product when the resolver only needed a variant chosen", async () => {
    const variantConflict = Object.assign(new ConflictError("Which variant?"), {
      reason: "variant_required",
      target: {
        kind: "order_line_variant",
        lineIndex: 0,
        productId,
        productName: "Наполеон",
      },
      options: [{ id: otherId, label: "1 кг" }],
      optionsTruncated: false,
    });
    const execute = vi.fn((actionName: string) =>
      actionName === CATALOG_RESOLVE_LINE_REFERENCES_ACTION_NAME
        ? Promise.reject(variantConflict)
        : Promise.resolve({ id: productId, name: "Наполеон" }),
    );
    const result = await runTool(execute, { productQuery: "Наполеон" });
    expect(execute).toHaveBeenNthCalledWith(
      2,
      CATALOG_GET_PRODUCT_ACTION_NAME,
      { productId },
      { toolCallId: "call-product" },
    );
    expect(result).toEqual({ id: productId, name: "Наполеон" });
  });

  it("turns nothing matched into a picker whose only option is create", async () => {
    const error: unknown = await runTool(
      () => Promise.reject(new NotFoundError()),
      { productQuery: "Наполеон" },
    ).catch((thrown: unknown) => thrown);
    expect(catalogPickerConflictExtrasFromError(error)).toEqual({
      reason: "unmatched_query",
      target: { kind: "product", query: "Наполеон" },
      options: [],
      optionsTruncated: false,
      create: { optionId: CHOICE_CREATE_OPTION_ID, label: 'Create "Наполеон"' },
    });
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

  it("tells the model a named product is this tool and a plural is the list", () => {
    const description = catalogGetProductFacadeTools(getProduct, () =>
      Promise.resolve({}),
    )[CATALOG_GET_PRODUCT_TOOL_NAME]?.description;
    expect(description).toContain("means this tool, not the list");
    expect(description).toContain("catalog_list_products");
  });
});
