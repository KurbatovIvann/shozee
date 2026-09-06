import { defineActionContract } from "@showzy/core/contract";
import { ORDER_ENTITY_PROMPT_LINE } from "@showzy/validation/assistant-surfaces";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  actionContractToTool,
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  ensureAnthropicToolInputSchemaType,
  fromProviderToolName,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  pickStaffAssistantForcedTool,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  PROVIDER_TOOL_NAME_PATTERN,
  staffAssistantHotToolNames,
  staffAssistantTools,
  STAFF_ASSISTANT_FACADE_TOOL_NAMES,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  toProviderToolName,
} from "./action-tool.js";
import {
  STAFF_ASSISTANT_CACHE_CONTROL,
  STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
} from "./anthropic-options.js";
import { CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT } from "./tool-facades/customers-list-customers.js";
import { CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT } from "./tool-facades/customers-list-groups.js";
import { ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT } from "./tool-facades/orders-list.js";

const customerId = "11111111-1111-4111-8111-111111111111";

const listOrders = defineActionContract({
  name: "orders.list",
  description: "List orders in the active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["orders:view"],
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
    items: z.array(z.object({ orderId: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

const deleteCustomer = defineActionContract({
  name: "customers.deleteCustomer",
  description: "Hard-delete an archived CRM customer. Requires confirmation.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["customers:delete"],
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
});

describe("toProviderToolName", () => {
  it("maps dotted action names onto Anthropic-safe keys and round-trips", () => {
    expect(toProviderToolName("orders.list")).toBe("orders_list");
    expect(toProviderToolName("customers.deleteCustomer")).toBe(
      "customers_deleteCustomer",
    );
    expect(toProviderToolName("orders.list")).toMatch(
      PROVIDER_TOOL_NAME_PATTERN,
    );
    expect(fromProviderToolName("orders_list")).toBe("orders.list");
    expect(fromProviderToolName("customers_deleteCustomer")).toBe(
      "customers.deleteCustomer",
    );
    expect(
      fromProviderToolName(toProviderToolName("customers.deleteCustomer")),
    ).toBe("customers.deleteCustomer");
  });
});

describe("STAFF_ASSISTANT_FACADE_TOOL_NAMES", () => {
  it("lists registered façade keys for contract-check, not the BM25 search tool", () => {
    expect(STAFF_ASSISTANT_FACADE_TOOL_NAMES).toContain(
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(STAFF_ASSISTANT_FACADE_TOOL_NAMES).toContain(
      ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    expect(STAFF_ASSISTANT_FACADE_TOOL_NAMES).toContain(
      CUSTOMERS_LIST_GROUPS_TOOL_NAME,
    );
    expect(STAFF_ASSISTANT_FACADE_TOOL_NAMES).not.toContain(
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    );
    expect(Object.isFrozen(STAFF_ASSISTANT_FACADE_TOOL_NAMES)).toBe(true);
  });
});

describe("actionContractToTool", () => {
  it("passes the action name and validated input to the injected execute callback", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn((actionName: string, input: unknown) =>
      Promise.resolve({ actionName, input }),
    );

    const aiTool = actionContractToTool(deleteCustomer, execute);
    expect(aiTool.description).toBe(deleteCustomer.description);
    expect(aiTool.execute).toBeTypeOf("function");

    await aiTool.execute?.(
      { id: customerId },
      {
        toolCallId: "tool-1",
        messages: [],
        context: undefined,
      },
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "customers.deleteCustomer",
      { id: customerId },
      { toolCallId: "tool-1" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("patches Anthropic input_schema.type on remaining 1:1 union tools", async () => {
    const unionList = defineActionContract({
      name: "documents.listDocuments",
      description: "List documents.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["documents:view"],
      risk: "read",
      requiresConfirmation: false,
      idempotent: false,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: [],
      audit: false,
      timeout: 5_000,
      input: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("page") }),
        z.strictObject({ kind: z.literal("aggregate") }),
      ]),
      output: z.object({ ok: z.boolean() }),
    });
    const raw = { ...z.toJSONSchema(unionList.input) };
    expect(raw["type"]).toBeUndefined();
    const aiTool = actionContractToTool(unionList, () =>
      Promise.resolve({ ok: true }),
    );
    const json = await asSchema(aiTool.inputSchema).jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeDefined();
  });

  it("exposes the contract input schema as the AI SDK tool schema", async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true }));
    const aiTool = actionContractToTool(deleteCustomer, execute);
    const schema = asSchema(aiTool.inputSchema);

    const rejected = await schema.validate?.({ id: "not-a-uuid" });
    expect(rejected?.success).toBe(false);

    const accepted = await schema.validate?.({ id: customerId });
    expect(accepted).toEqual({
      success: true,
      value: { id: customerId },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not invoke execute when input fails the contract schema", async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true }));
    const aiTool = actionContractToTool(deleteCustomer, execute);

    await expect(
      aiTool.execute?.(
        { id: "not-a-uuid" },
        { toolCallId: "tool-2", messages: [], context: undefined },
      ),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("ensureAnthropicToolInputSchemaType", () => {
  it("adds type object to Zod 4 union schemas that omit type", () => {
    const union = z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("page.summary") }),
      z.strictObject({ kind: z.literal("aggregate") }),
    ]);
    const raw = { ...z.toJSONSchema(union) };
    expect(raw["type"]).toBeUndefined();
    expect(raw["oneOf"]).toBeDefined();
    expect(ensureAnthropicToolInputSchemaType(raw)["type"]).toBe("object");
  });

  it("leaves object schemas that already have type unchanged", () => {
    const objectSchema = z.strictObject({ query: z.string().optional() });
    const raw = { ...z.toJSONSchema(objectSchema) };
    expect(raw["type"]).toBe("object");
    expect(ensureAnthropicToolInputSchemaType(raw)).toEqual(raw);
  });
});

describe("staffAssistantTools", () => {
  it("advertises named orders.list façades and still dispatches to orders.list", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    const tools = staffAssistantTools([listOrders, deleteCustomer], execute);
    const names = Object.keys(tools);
    expect(names).toEqual([
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
      ORDERS_LIST_PAGE_TOOL_NAME,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      "customers_deleteCustomer",
    ]);
    expect(names).not.toContain("orders_list");
    expect(names).not.toContain(toProviderToolName("orders.list"));
    for (const name of names) {
      expect(name).toMatch(PROVIDER_TOOL_NAME_PATTERN);
      expect(name).not.toContain(".");
    }
    await tools[ORDERS_LIST_PAGE_TOOL_NAME]?.execute?.(
      {},
      { toolCallId: "call-1", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "orders.list",
      { kind: "page.summary", limit: ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT },
      { toolCallId: "call-1" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps hot façades and search in context and defers the rest", () => {
    const tools = staffAssistantTools([listOrders, deleteCustomer], () =>
      Promise.resolve({ items: [] }),
    );
    expect(tools[STAFF_ASSISTANT_TOOL_SEARCH_NAME]).toBeDefined();
    expect(tools[ORDERS_LIST_COUNTS_TOOL_NAME]?.providerOptions).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_CACHE_CONTROL },
    });
    expect(tools[ORDERS_LIST_PAGE_TOOL_NAME]?.providerOptions).toBeUndefined();
    expect(tools["customers_deleteCustomer"]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
  });

  it("lists advertised hot tool names rather than the 1:1 union keys", () => {
    expect(staffAssistantHotToolNames()).toEqual([
      ORDERS_LIST_PAGE_TOOL_NAME,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      "orders_get",
      ORDERS_CREATE_TOOL_NAME,
      CATALOG_LIST_PRODUCTS_TOOL_NAME,
      PRICING_LIST_PRICE_LISTS_TOOL_NAME,
      CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
    ]);
    expect(staffAssistantHotToolNames()).not.toContain("orders_list");
    expect(staffAssistantHotToolNames()).not.toContain("catalog_listProducts");
    expect(staffAssistantHotToolNames()).not.toContain(
      "pricing_listPriceLists",
    );
    expect(staffAssistantHotToolNames()).not.toContain(
      "customers_listCustomers",
    );
    expect(staffAssistantHotToolNames()).not.toContain(
      CUSTOMERS_LIST_GROUPS_TOOL_NAME,
    );
    expect(staffAssistantHotToolNames()).not.toContain("customers_listGroups");
  });

  it("appends the order entity prompt line to orders.get", () => {
    const getOrder = defineActionContract({
      name: "orders.get",
      description:
        "Return a staff-intake order and its immutable line snapshots in the active company.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["orders:view"],
      risk: "read",
      requiresConfirmation: false,
      idempotent: false,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: ["NOT_FOUND"],
      audit: false,
      timeout: 2_000,
      input: z.object({ orderId: z.uuid() }),
      output: z.object({ orderId: z.uuid() }),
    });
    const tools = staffAssistantTools([getOrder], () => Promise.resolve({}));
    expect(tools["orders_get"]?.description).toContain(
      ORDER_ENTITY_PROMPT_LINE,
    );
  });

  it("caches search when every domain tool is deferred", () => {
    const tools = staffAssistantTools([deleteCustomer], () =>
      Promise.resolve({}),
    );
    expect(tools[STAFF_ASSISTANT_TOOL_SEARCH_NAME]?.providerOptions).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_CACHE_CONTROL },
    });
    expect(tools["customers_deleteCustomer"]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
  });

  it("attaches nothing when the contract list is empty", () => {
    const tools = staffAssistantTools([], () => Promise.resolve({}));
    expect(tools).toEqual({});
  });

  it("picks a single forced job tool and drops BM25 plus sibling façades", () => {
    const tools = staffAssistantTools([listOrders, deleteCustomer], () =>
      Promise.resolve({ items: [] }),
    );
    const forced = pickStaffAssistantForcedTool(
      tools,
      ORDERS_LIST_PAGE_TOOL_NAME,
    );
    expect(Object.keys(forced)).toEqual([ORDERS_LIST_PAGE_TOOL_NAME]);
    expect(forced[STAFF_ASSISTANT_TOOL_SEARCH_NAME]).toBeUndefined();
    expect(forced[ORDERS_LIST_COUNTS_TOOL_NAME]).toBeUndefined();
    expect(pickStaffAssistantForcedTool(tools, "orders_list_missing")).toEqual(
      {},
    );
  });

  it("advertises catalog_list_products and still dispatches to catalog.listProducts", async () => {
    const listProducts = defineActionContract({
      name: "catalog.listProducts",
      description: "List products in the active company.",
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
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: customerId,
            name: "Seed",
            basePriceMinor: "1000",
            currency: "UAH",
            status: "active",
            variantCount: 0,
            primaryImageFileId: null,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    const tools = staffAssistantTools([listProducts], execute);
    const names = Object.keys(tools);
    expect(names).toContain(CATALOG_LIST_PRODUCTS_TOOL_NAME);
    expect(names).not.toContain("catalog_listProducts");
    expect(names).not.toContain(toProviderToolName("catalog.listProducts"));
    const executeTool = tools[CATALOG_LIST_PRODUCTS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      {},
      { toolCallId: "call-catalog", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "catalog.listProducts",
      { status: "active", limit: 20 },
      { toolCallId: "call-catalog" },
    );
    expect(result).toEqual({
      items: [
        {
          id: customerId,
          name: "Seed",
          basePriceMinor: "1000",
          currency: "UAH",
          status: "active",
          variantCount: 0,
        },
      ],
      nextCursor: null,
    });
  });

  it("advertises pricing_list_price_lists and still dispatches to pricing.listPriceLists", async () => {
    const listPriceLists = defineActionContract({
      name: "pricing.listPriceLists",
      description: "List price lists in the active company.",
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
        query: z.string().trim().min(1).max(100).optional(),
        availability: z.enum(["all", "active", "inactive"]).default("all"),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().min(1).max(200).optional(),
      }),
      output: z.object({
        items: z.array(z.object({ id: z.uuid() })),
        nextCursor: z.string().nullable(),
      }),
    });
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: customerId,
            name: "Opt",
            isDefault: false,
            isActive: true,
            entryCount: 0,
          },
        ],
        nextCursor: null,
      }),
    );
    const tools = staffAssistantTools([listPriceLists], execute);
    const names = Object.keys(tools);
    expect(names).toContain(PRICING_LIST_PRICE_LISTS_TOOL_NAME);
    expect(names).not.toContain("pricing_listPriceLists");
    expect(names).not.toContain(toProviderToolName("pricing.listPriceLists"));
    const executeTool = tools[PRICING_LIST_PRICE_LISTS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { query: "Opt" },
      { toolCallId: "call-pricing", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "pricing.listPriceLists",
      { query: "Opt", availability: "all", limit: 20 },
      { toolCallId: "call-pricing" },
    );
    expect(result).toEqual({
      items: [
        {
          id: customerId,
          name: "Opt",
          isDefault: false,
          isActive: true,
          entryCount: 0,
        },
      ],
      nextCursor: null,
    });
  });

  it("keeps pricing writes deferred and does not flatten their schemas", async () => {
    const createPriceList = defineActionContract({
      name: "pricing.createPriceList",
      description: "Create a price list in the staff member's active company.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["pricing:manage"],
      risk: "write",
      requiresConfirmation: false,
      idempotent: true,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: ["VALIDATION"],
      audit: true,
      timeout: 5_000,
      input: z.strictObject({
        name: z.string().min(1),
        isDefault: z.boolean().default(false),
        isActive: z.boolean().default(true),
      }),
      output: z.object({ id: z.uuid() }),
    });
    const setPriceListEntries = defineActionContract({
      name: "pricing.setPriceListEntries",
      description: "Upsert prices on a price list.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["pricing:manage"],
      risk: "write",
      requiresConfirmation: false,
      idempotent: true,
      emits: [],
      atomicCalls: [],
      atomicCallers: [],
      errors: ["VALIDATION", "NOT_FOUND"],
      audit: true,
      timeout: 10_000,
      input: z.strictObject({
        priceListId: z.uuid(),
        entries: z.array(z.strictObject({ productId: z.uuid() })).min(1),
      }),
      output: z.object({ items: z.array(z.object({ id: z.uuid() })) }),
    });
    const tools = staffAssistantTools(
      [createPriceList, setPriceListEntries],
      () => Promise.resolve({}),
    );
    const createName = toProviderToolName("pricing.createPriceList");
    const setName = toProviderToolName("pricing.setPriceListEntries");
    expect(Object.keys(tools)).toContain(createName);
    expect(Object.keys(tools)).toContain(setName);
    expect(tools[createName]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
    expect(tools[setName]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
    expect(tools[createName]?.description).toContain(
      "pricing_list_price_lists",
    );
    expect(tools[createName]?.description).toContain(
      "pricing.setPriceListEntries",
    );
    expect(tools[setName]?.description).toContain("catalog_list_products");
    const setJson = await asSchema(tools[setName]?.inputSchema).jsonSchema;
    expect(setJson["type"]).toBe("object");
    expect(setJson["oneOf"]).toBeUndefined();
  });

  it("advertises orders_create as a named object and still dispatches to orders.create", async () => {
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
        customer: z.discriminatedUnion("by", [
          z.strictObject({ by: z.literal("id"), id: z.uuid() }),
          z.strictObject({ by: z.literal("query"), value: z.string() }),
        ]),
        items: z.array(z.looseObject({})).min(1),
      }),
      output: z.object({ orderId: z.uuid() }),
    });
    const execute = vi.fn(() => Promise.resolve({ orderId: customerId }));
    const tools = staffAssistantTools([createOrder], execute);
    const names = Object.keys(tools);
    expect(names).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(names).toContain(toProviderToolName("orders.create"));
    expect(names).not.toContain("orders.create");
    const json = await asSchema(tools[ORDERS_CREATE_TOOL_NAME]?.inputSchema)
      .jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
    expect(json["properties"]).not.toHaveProperty("customer");
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
      "orders.create",
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
    expect(tools[ORDERS_CREATE_TOOL_NAME]?.providerOptions).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_CACHE_CONTROL },
    });
  });

  it("advertises customers_list_customers and still dispatches to customers.listCustomers", async () => {
    const listCustomers = defineActionContract({
      name: "customers.listCustomers",
      description: "List CRM customers in the staff member's active company.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["customers:view"],
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
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: customerId,
            name: "Катя",
            phone: "+380501234567",
            email: "katya@example.com",
            userId: "user_secret",
            notes: "do not leak",
            groupId: null,
            priceListId: null,
            status: "active",
            linkedCounterpartyCount: 2,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    const tools = staffAssistantTools([listCustomers], execute);
    const names = Object.keys(tools);
    expect(names).toContain(CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME);
    expect(names).not.toContain("customers_listCustomers");
    expect(names).not.toContain(toProviderToolName("customers.listCustomers"));
    const executeTool = tools[CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { search: "Катя" },
      { toolCallId: "call-customers", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "customers.listCustomers",
      {
        status: "active",
        search: "Катя",
        limit: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-customers" },
    );
    expect(result).toEqual({
      items: [
        {
          id: customerId,
          name: "Катя",
          phone: "+380501234567",
          email: "katya@example.com",
          status: "active",
          groupId: null,
          priceListId: null,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toContain("do not leak");
    expect(JSON.stringify(result)).not.toContain("user_secret");
    expect(JSON.stringify(result)).not.toContain("linkedCounterpartyCount");
  });

  it("advertises deferred customers_list_groups and still dispatches to customers.listGroups", async () => {
    const listGroups = defineActionContract({
      name: "customers.listGroups",
      description: "List customer groups in the staff member's active company.",
      principal: "staff",
      transport: "client",
      aiExposure: "exposed",
      permissions: ["customers:view"],
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
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [
          {
            id: customerId,
            name: "VIP",
            slug: "vip",
            description: "do not leak description",
            priceListId: null,
            memberCount: 4,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
    const tools = staffAssistantTools([listGroups], execute);
    const names = Object.keys(tools);
    expect(names).toContain(CUSTOMERS_LIST_GROUPS_TOOL_NAME);
    expect(names).not.toContain("customers_listGroups");
    expect(names).not.toContain(toProviderToolName("customers.listGroups"));
    expect(tools[CUSTOMERS_LIST_GROUPS_TOOL_NAME]?.providerOptions).toEqual(
      STAFF_ASSISTANT_DEFER_PROVIDER_OPTIONS,
    );
    expect(tools[STAFF_ASSISTANT_TOOL_SEARCH_NAME]?.providerOptions).toEqual({
      anthropic: { cacheControl: STAFF_ASSISTANT_CACHE_CONTROL },
    });
    const executeTool = tools[CUSTOMERS_LIST_GROUPS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { search: "VIP" },
      { toolCallId: "call-groups", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      "customers.listGroups",
      {
        search: "VIP",
        limit: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-groups" },
    );
    expect(result).toEqual({
      items: [
        {
          id: customerId,
          name: "VIP",
          memberCount: 4,
          priceListId: null,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toContain("do not leak description");
    expect(JSON.stringify(result)).not.toContain("slug");
    expect(JSON.stringify(result)).not.toContain("createdAt");
  });
});
