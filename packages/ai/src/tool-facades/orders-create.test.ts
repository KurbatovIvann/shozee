import { defineActionContract } from "@showzy/core/contract";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ORDER_ENTITY_PROMPT_LINE } from "@showzy/validation/assistant-surfaces";
import {
  CREATE_ORDER_COMMENT_MAX,
  CREATE_ORDER_MAX_ITEMS,
  mapOrdersCreateInput,
  ORDERS_CREATE_ACTION_NAME,
  ORDERS_CREATE_QUERY_MAX,
  ORDERS_CREATE_TOOL_NAME,
  ordersCreateFacadeTools,
  ordersCreateInputSchema,
} from "./orders-create.js";

const entityRef = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("id"), id: z.uuid() }),
  z.strictObject({
    by: z.literal("query"),
    value: z.string().trim().min(1).max(ORDERS_CREATE_QUERY_MAX),
  }),
]);

const createOrder = defineActionContract({
  name: "orders.create",
  description: "Create a staff-intake order in the active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["orders:create"],
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["orders.created"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 20_000,
  input: z.strictObject({
    customer: entityRef,
    items: z
      .array(
        z.strictObject({
          product: entityRef,
          variant: entityRef.optional(),
          variantSelection: z
            .discriminatedUnion("kind", [
              z.strictObject({ kind: z.literal("unspecified") }),
              z.strictObject({ kind: z.literal("base") }),
              z.strictObject({
                kind: z.literal("reference"),
                ref: entityRef,
              }),
            ])
            .optional(),
          quantity: z.union([
            z.strictObject({ milli: z.string() }),
            z.strictObject({ decimal: z.string() }),
          ]),
        }),
      )
      .min(1)
      .max(CREATE_ORDER_MAX_ITEMS),
    comment: z.string().max(CREATE_ORDER_COMMENT_MAX).optional(),
  }),
  output: z.object({ orderId: z.uuid() }),
});

const customerId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const variantId = "33333333-3333-4333-8333-333333333333";

describe("mapOrdersCreateInput", () => {
  it("maps customerQuery, product query, and decimal quantity onto EntityRef", () => {
    const parsed = ordersCreateInputSchema.parse({
      customerQuery: "  Katya  ",
      items: [
        {
          productQuery: "Cake",
          quantityDecimal: "1.5",
        },
      ],
    });
    expect(mapOrdersCreateInput(parsed)).toEqual({
      customer: { by: "query", value: "Katya" },
      items: [
        {
          product: { by: "query", value: "Cake" },
          variantSelection: { kind: "unspecified" },
          quantity: { decimal: "1.5" },
        },
      ],
    });
  });

  it("maps omit of variantQuery and variantId to unspecified, never base", () => {
    const parsed = ordersCreateInputSchema.parse({
      customerId,
      items: [{ productId, quantityMilli: "1000" }],
    });
    const mapped = mapOrdersCreateInput(parsed);
    expect(mapped.items[0]?.variantSelection).toEqual({ kind: "unspecified" });
    expect(JSON.stringify(mapped)).not.toContain('"kind":"base"');
    expect(mapped.items[0]).not.toHaveProperty("variant");
  });

  it("maps UUID locators onto by id EntityRef", () => {
    const parsed = ordersCreateInputSchema.parse({
      customerId,
      items: [
        {
          productId,
          variantId,
          quantityMilli: "1000",
        },
      ],
      comment: "leave at the door",
    });
    expect(mapOrdersCreateInput(parsed)).toEqual({
      customer: { by: "id", id: customerId },
      items: [
        {
          product: { by: "id", id: productId },
          variantSelection: {
            kind: "reference",
            ref: { by: "id", id: variantId },
          },
          quantity: { milli: "1000" },
        },
      ],
      comment: "leave at the door",
    });
  });

  it("maps variantQuery onto an optional query EntityRef", () => {
    const parsed = ordersCreateInputSchema.parse({
      customerId,
      items: [
        {
          productQuery: "Cake",
          variantQuery: "  Large  ",
          quantityMilli: "2000",
        },
      ],
    });
    expect(mapOrdersCreateInput(parsed)).toEqual({
      customer: { by: "id", id: customerId },
      items: [
        {
          product: { by: "query", value: "Cake" },
          variantSelection: {
            kind: "reference",
            ref: { by: "query", value: "Large" },
          },
          quantity: { milli: "2000" },
        },
      ],
    });
  });
});

describe("ordersCreateInputSchema", () => {
  it("rejects both customer locators at once", () => {
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        customerQuery: "Katya",
        items: [{ productId, quantityMilli: "1000" }],
      }).success,
    ).toBe(false);
  });

  it("rejects both product locators at once", () => {
    expect(
      ordersCreateInputSchema.safeParse({
        customerQuery: "Katya",
        items: [
          {
            productId,
            productQuery: "Cake",
            quantityDecimal: "1",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects both variant locators at once", () => {
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        items: [
          {
            productId,
            variantId,
            variantQuery: "Large",
            quantityMilli: "1000",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects both quantity forms at once", () => {
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        items: [
          {
            productId,
            quantityMilli: "1000",
            quantityDecimal: "1",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects EntityRef-shaped customer input", () => {
    expect(
      ordersCreateInputSchema.safeParse({
        customer: { by: "query", value: "Katya" },
        items: [{ productId, quantityMilli: "1000" }],
      }).success,
    ).toBe(false);
  });

  it("duplicates create caps and rejects empty items, overlong query, or overlong comment", () => {
    expect(CREATE_ORDER_MAX_ITEMS).toBe(100);
    expect(CREATE_ORDER_COMMENT_MAX).toBe(2000);
    expect(ORDERS_CREATE_QUERY_MAX).toBe(100);
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        items: [],
      }).success,
    ).toBe(false);
    expect(
      ordersCreateInputSchema.safeParse({
        customerQuery: "q".repeat(ORDERS_CREATE_QUERY_MAX + 1),
        items: [{ productId, quantityMilli: "1000" }],
      }).success,
    ).toBe(false);
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        items: [{ productId, quantityMilli: "1000" }],
        comment: "c".repeat(CREATE_ORDER_COMMENT_MAX + 1),
      }).success,
    ).toBe(false);
    const oversized = Array.from(
      { length: CREATE_ORDER_MAX_ITEMS + 1 },
      (_, index) => ({
        productQuery: `Product ${String(index)}`,
        quantityMilli: "1000",
      }),
    );
    expect(
      ordersCreateInputSchema.safeParse({
        customerId,
        items: oversized,
      }).success,
    ).toBe(false);
  });
});

describe("ordersCreateFacadeTools", () => {
  it("executes orders.create with mapped canonical input and toolCallId", async () => {
    const execute = vi.fn(() => Promise.resolve({ orderId: customerId }));
    const tools = ordersCreateFacadeTools(createOrder, execute);
    const executeTool = tools[ORDERS_CREATE_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    await executeTool(
      {
        customerQuery: "Katya",
        items: [{ productQuery: "Cake", quantityDecimal: "1.5" }],
      },
      { toolCallId: "call-create", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      ORDERS_CREATE_ACTION_NAME,
      {
        customer: { by: "query", value: "Katya" },
        items: [
          {
            product: { by: "query", value: "Cake" },
            variantSelection: { kind: "unspecified" },
            quantity: { decimal: "1.5" },
          },
        ],
      },
      { toolCallId: "call-create" },
    );
  });

  it("does not execute when both locators are present", async () => {
    const execute = vi.fn(() => Promise.resolve({ orderId: customerId }));
    const tools = ordersCreateFacadeTools(createOrder, execute);
    const executeTool = tools[ORDERS_CREATE_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    await expect(
      executeTool(
        {
          customerId,
          customerQuery: "Katya",
          items: [{ productId, quantityMilli: "1000" }],
        },
        { toolCallId: "call-both", messages: [], context: undefined },
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("exposes object JSON Schema type without the Anthropic union patch", async () => {
    const tools = ordersCreateFacadeTools(createOrder, () =>
      Promise.resolve({ orderId: customerId }),
    );
    const json = await asSchema(tools[ORDERS_CREATE_TOOL_NAME]?.inputSchema)
      .jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
    expect(json["properties"]).toHaveProperty("customerId");
    expect(json["properties"]).toHaveProperty("customerQuery");
    expect(json["properties"]).toHaveProperty("items");
    expect(json["properties"]).not.toHaveProperty("customer");
  });

  it("tells the model to use named locators and not a mega-action", () => {
    const tools = ordersCreateFacadeTools(createOrder, () =>
      Promise.resolve({ orderId: customerId }),
    );
    expect(tools[ORDERS_CREATE_TOOL_NAME]?.description).toContain(
      "customerId or customerQuery",
    );
    expect(tools[ORDERS_CREATE_TOOL_NAME]?.description).toContain(
      "Do not send EntityRef",
    );
    expect(tools[ORDERS_CREATE_TOOL_NAME]?.description).toContain(
      "Creating a customer, group, or price list is a separate write",
    );
    expect(tools[ORDERS_CREATE_TOOL_NAME]?.description).toContain(
      ORDER_ENTITY_PROMPT_LINE,
    );
  });
});
