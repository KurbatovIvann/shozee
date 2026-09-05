import { readFileSync } from "node:fs";

import {
  ConfirmationRequiredError,
  ConflictError,
  NotFoundError,
} from "@showzy/core/errors";
import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  PRICING_LIST_PRICE_LISTS_TOOL_NAME,
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
  toProviderToolName,
} from "./action-tool.js";
import {
  STAFF_ASSISTANT_CACHE_CONTROL,
  STAFF_ASSISTANT_THINKING_DISABLED,
} from "./anthropic-options.js";
import {
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_ARRAY_MAX,
} from "./clip-tool-result.js";
import {
  isStaffAssistantConfirmationOutput,
  STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT,
} from "./confirmation.js";
import {
  STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK,
  STAFF_ASSISTANT_SYNTHETIC_JSON_TOOL_NAME,
  STAFF_ASSISTANT_TOOL_ERROR_FALLBACK,
} from "./spoken-reply.js";
import {
  extractUuidResultIds,
  STAFF_ASSISTANT_MAX_STEPS,
  streamStaffAssistantChat,
} from "./staff-assistant-stream.js";
import {
  CHOICE_TRUNCATED_COPY,
  CHOICE_TRUNCATED_MATCH_COPY,
  presentCatalogDomainError,
  presentCompletedStaffAssistantTurn,
  STAFF_ASSISTANT_DEFAULT_LOCALE,
} from "./presenter.js";
import { staffAssistantSystemPrompt } from "./system-prompt.js";
import {
  MockLanguageModelV3,
  mockJsonToolAndSpokenStream,
  mockSpokenStream,
  mockTextStream,
  mockToolCallAndSpokenStream,
  mockToolCallStream,
  readUiMessageSsePayloads,
  sseVisibleTextFromPayloads,
} from "./test.js";
import { CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT } from "./tool-facades/customers-list-customers.js";
import { CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT } from "./tool-facades/customers-list-groups.js";
import { ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT } from "./tool-facades/orders-list.js";
import { STAFF_ASSISTANT_EMPTY_TOOLSET_HASH } from "./toolset-hash.js";
import { staffAssistantTurnContextAddendum } from "./turn-context.js";
import { staffAssistantWorkingSetAddendum } from "./working-set.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function anthropicCacheControl(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value["providerOptions"])) {
    return undefined;
  }
  const anthropic = value["providerOptions"]["anthropic"];
  if (!isRecord(anthropic)) {
    return undefined;
  }
  return anthropic["cacheControl"];
}

function anthropicDeferLoading(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value["providerOptions"])) {
    return undefined;
  }
  const anthropic = value["providerOptions"]["anthropic"];
  if (!isRecord(anthropic)) {
    return undefined;
  }
  return anthropic["deferLoading"];
}

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
  audit: true,
  timeout: 5_000,
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.uuid() }),
});

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
  audit: false,
  timeout: 5_000,
  input: z.looseObject({}),
  output: z.object({
    items: z.array(z.object({ id: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

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
  audit: false,
  timeout: 5_000,
  input: z.looseObject({}),
  output: z.object({
    items: z.array(z.object({ id: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

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
  audit: false,
  timeout: 5_000,
  input: z.looseObject({}),
  output: z.object({
    items: z.array(z.object({ id: z.uuid() })),
    nextCursor: z.string().nullable(),
  }),
});

const getOrder = defineActionContract({
  name: "orders.get",
  description: "Get an order in the active company.",
  principal: "staff",
  transport: "client",
  aiExposure: "exposed",
  permissions: ["orders:view"],
  risk: "read",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  audit: false,
  timeout: 5_000,
  input: z.object({ orderId: z.uuid() }),
  output: z.object({
    orderId: z.uuid(),
    orderNumber: z.string(),
    status: z.string(),
  }),
});

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
  audit: true,
  timeout: 20_000,
  input: z.strictObject({
    customer: z.discriminatedUnion("by", [
      z.strictObject({ by: z.literal("id"), id: z.uuid() }),
      z.strictObject({ by: z.literal("query"), value: z.string() }),
    ]),
    items: z
      .array(
        z.strictObject({
          product: z.discriminatedUnion("by", [
            z.strictObject({ by: z.literal("id"), id: z.uuid() }),
            z.strictObject({ by: z.literal("query"), value: z.string() }),
          ]),
          quantity: z.union([
            z.strictObject({ milli: z.string() }),
            z.strictObject({ decimal: z.string() }),
          ]),
          variantSelection: z
            .discriminatedUnion("kind", [
              z.strictObject({ kind: z.literal("unspecified") }),
              z.strictObject({ kind: z.literal("base") }),
              z.strictObject({
                kind: z.literal("reference"),
                ref: z.discriminatedUnion("by", [
                  z.strictObject({ by: z.literal("id"), id: z.uuid() }),
                  z.strictObject({
                    by: z.literal("query"),
                    value: z.string(),
                  }),
                ]),
              }),
            ])
            .optional(),
        }),
      )
      .min(1),
  }),
  output: z.object({ orderId: z.uuid() }),
});

const customerId = "11111111-1111-4111-8111-111111111111";
const challengeId = "22222222-2222-4222-8222-222222222222";

describe("extractUuidResultIds", () => {
  it("collects top-level uuid ids and ignores nested list rows", () => {
    const orderId = "33333333-3333-4333-8333-333333333333";
    const nestedOrderId = "44444444-4444-4444-8444-444444444444";
    expect(extractUuidResultIds({ orderId, status: "new" })).toEqual([orderId]);
    expect(
      extractUuidResultIds({
        items: [{ orderId }],
        nextCursor: null,
      }),
    ).toEqual([]);
    expect(
      extractUuidResultIds({
        kind: "page.summary",
        items: [{ orderId: nestedOrderId }, { orderId }],
        nextCursor: null,
      }),
    ).toEqual([]);
    expect(
      extractUuidResultIds({
        orderId,
        items: [{ orderId: nestedOrderId }],
      }),
    ).toEqual([orderId]);
    const source = readFileSync(
      new URL("./staff-assistant-stream.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("export function extractUuidResultIds");
    const end = source.indexOf("function clipToolCallId");
    const fn = source.slice(start, end);
    expect(fn).toContain("RESULT_ID_KEYS");
    expect(fn).not.toContain("items");
    expect(fn).not.toContain("orderId]");
  });
});

describe("staffAssistantTools", () => {
  it("keys tools by provider-safe name and never calls fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    const tools = staffAssistantTools([listOrders], execute);
    expect(Object.keys(tools)).toEqual([
      STAFF_ASSISTANT_TOOL_SEARCH_NAME,
      ORDERS_LIST_PAGE_TOOL_NAME,
      ORDERS_LIST_COUNTS_TOOL_NAME,
    ]);
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
});

describe("streamStaffAssistantChat", () => {
  it("raises the step cap so tool calls plus spoken JSON still fit", () => {
    expect(STAFF_ASSISTANT_MAX_STEPS).toBe(9);
  });

  it("runs a read tool and streams UI-message SSE without touching the network", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });

    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });

    expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;

    expect(execute).toHaveBeenCalledWith(
      "orders.list",
      { kind: "page.summary", limit: ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT },
      { toolCallId: "call-list" },
    );
    expect(turn.toolRuns).toEqual([
      {
        actionName: "orders.list",
        toolCallId: "call-list",
        resultIds: [],
        outcome: "success",
      },
    ]);
    expect(turn.text).toBe("Немає замовлень.");
    expect(turn.text).not.toBe("You have no orders.");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("You have no orders.");
    expect(turn.toolsAttached).toBe(true);
    expect(turn.usage.inputTokens).toEqual(expect.any(Number));
    expect(turn.usage.outputTokens).toEqual(expect.any(Number));
    expect(turn.usage.cacheReadTokens).toEqual(expect.any(Number));
    expect(turn.usage.cacheWriteTokens).toEqual(expect.any(Number));
    expect(turn.modelSteps).toBeGreaterThanOrEqual(1);
    expect(turn.historyMessageCount).toBe(1);
    expect(turn.historyChars).toBe("List orders".length);
    expect(turn.toolsetHash).not.toBe(STAFF_ASSISTANT_EMPTY_TOOLSET_HASH);
    expect(turn.toolResultBytesIn).toBeGreaterThan(0);
    expect(turn.toolResultBytesOut).toBe(turn.toolResultBytesIn);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("pins Anthropic thinking to disabled on every streamText call", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Hello" }],
      contracts: [listOrders],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    await readUiMessageSsePayloads(response);
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    for (const call of model.doStreamCalls) {
      expect(call.providerOptions?.["anthropic"]).toMatchObject({
        thinking: { type: STAFF_ASSISTANT_THINKING_DISABLED },
      });
    }
  });

  it("sets Anthropic cache breakpoints on the system message and last tool", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Hello" }],
      contracts: [listOrders, deleteCustomer],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    await readUiMessageSsePayloads(response);
    const call = model.doStreamCalls[0];
    expect(call).toBeDefined();
    const systemMessages = (call?.prompt ?? []).filter(
      (part) => part.role === "system",
    );
    expect(systemMessages.length).toBe(2);
    expect(systemMessages[0]).toMatchObject({
      content: staffAssistantSystemPrompt,
    });
    expect(anthropicCacheControl(systemMessages[0])).toEqual(
      STAFF_ASSISTANT_CACHE_CONTROL,
    );
    expect(anthropicCacheControl(systemMessages[1])).toBeUndefined();
    expect(JSON.stringify(systemMessages[0])).not.toContain(
      "Turn context (not cached",
    );
    expect(JSON.stringify(systemMessages[1])).toContain(
      "Turn context (not cached",
    );
    expect(JSON.stringify(systemMessages[1])).toContain(
      "week starts on Monday",
    );
    const tools = call?.tools ?? [];
    expect(tools.length).toBe(4);
    const search = tools.find(
      (entry) =>
        isRecord(entry) && entry["name"] === STAFF_ASSISTANT_TOOL_SEARCH_NAME,
    );
    const page = tools.find(
      (entry) =>
        isRecord(entry) && entry["name"] === ORDERS_LIST_PAGE_TOOL_NAME,
    );
    const counts = tools.find(
      (entry) =>
        isRecord(entry) && entry["name"] === ORDERS_LIST_COUNTS_TOOL_NAME,
    );
    const remove = tools.find(
      (entry) =>
        isRecord(entry) && entry["name"] === "customers_deleteCustomer",
    );
    expect(search).toBeDefined();
    expect(page).toBeDefined();
    expect(counts).toBeDefined();
    expect(
      tools.some((entry) => isRecord(entry) && entry["name"] === "orders_list"),
    ).toBe(false);
    expect(anthropicCacheControl(counts)).toEqual(
      STAFF_ASSISTANT_CACHE_CONTROL,
    );
    expect(anthropicDeferLoading(remove)).toBe(true);
    expect(anthropicDeferLoading(page)).toBeUndefined();
    expect(anthropicDeferLoading(counts)).toBeUndefined();
    expect(anthropicCacheControl(remove)).toBeUndefined();
    expect(
      tools.some(
        (entry) =>
          isRecord(entry) &&
          entry["name"] === STAFF_ASSISTANT_SYNTHETIC_JSON_TOOL_NAME,
      ),
    ).toBe(false);
    expect(call?.responseFormat).toMatchObject({
      type: "json",
    });
    const responseFormat = call?.responseFormat;
    expect(responseFormat?.type).toBe("json");
    const schemaJson =
      responseFormat?.type === "json"
        ? JSON.stringify(responseFormat.schema)
        : "";
    expect(schemaJson).toContain("spoken");
    expect(schemaJson).not.toContain("rows");
    expect(schemaJson).not.toContain("cards");
  });

  it("injects an uncached working-set system message without a second list call", async () => {
    const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const model = new MockLanguageModelV3({
      doStream: [
        mockTextStream("Those products are already in the working set."),
      ],
    });
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    const workingSetAddendum = staffAssistantWorkingSetAddendum([
      {
        actionName: "catalog.listProducts",
        resultIds: [productId],
        outcome: "success",
      },
    ]);
    expect(workingSetAddendum).toEqual(expect.stringContaining(productId));
    const turnContextAddendum = staffAssistantTurnContextAddendum({
      now: new Date("2026-09-02T12:00:00.000Z"),
      ...(workingSetAddendum !== undefined ? { workingSetAddendum } : {}),
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "What are those products?" }],
      contracts: [listOrders],
      execute,
      turnContextAddendum,
    });
    await readUiMessageSsePayloads(response);
    expect(execute).not.toHaveBeenCalled();
    const systemMessages = (model.doStreamCalls[0]?.prompt ?? []).filter(
      (part) => part.role === "system",
    );
    expect(systemMessages).toHaveLength(2);
    expect(anthropicCacheControl(systemMessages[0])).toEqual(
      STAFF_ASSISTANT_CACHE_CONTROL,
    );
    expect(anthropicCacheControl(systemMessages[1])).toBeUndefined();
    expect(JSON.stringify(systemMessages[0])).not.toContain(productId);
    expect(JSON.stringify(systemMessages[1])).toContain("catalog.listProducts");
    expect(JSON.stringify(systemMessages[1])).toContain(productId);
    expect(JSON.stringify(systemMessages[1])).toContain("Europe/Kyiv");
  });

  it("attaches no tools when the contract list is empty", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("I only help with this company.")],
    });
    const execute = vi.fn(() => Promise.resolve({ items: [] }));
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "What's the weather?" }],
      contracts: [],
      execute,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolsAttached).toBe(false);
    expect(turn.toolsetHash).toBe(STAFF_ASSISTANT_EMPTY_TOOLSET_HASH);
    expect(execute).not.toHaveBeenCalled();
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
  });

  it("clips a large list tool result before the second model step", async () => {
    function rowId(index: number): string {
      return `33333333-3333-4333-8333-${index.toString(16).padStart(12, "0")}`;
    }
    const items = Array.from(
      { length: STAFF_ASSISTANT_CLIP_ARRAY_MAX + 12 },
      (_, index) => ({ orderId: rowId(index) }),
    );
    const keptId = items[0]?.orderId;
    const droppedId = items[STAFF_ASSISTANT_CLIP_ARRAY_MAX]?.orderId;
    expect(keptId).toBeDefined();
    expect(droppedId).toBeDefined();
    const execute = vi.fn(() => Promise.resolve({ items, nextCursor: null }));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("Here is a preview of the orders."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolRuns[0]?.resultIds).toEqual([]);
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain(keptId);
    expect(secondStep).not.toContain(droppedId);
    expect(secondStep).toContain(STAFF_ASSISTANT_CLIPPED_STATUS);
    expect(turn.toolResultBytesIn).toBeGreaterThan(turn.toolResultBytesOut);
  });

  it("feeds a compact catalog page into the next step, not image ids", async () => {
    const imageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const items = Array.from({ length: 7 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
      name: `Seed ${String(index)}`,
      basePriceMinor: String(10_000 + index),
      currency: "UAH",
      status: "active",
      variantCount: 0,
      primaryImageFileId: imageId,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-02T08:00:00.000Z",
    }));
    const execute = vi.fn(() => Promise.resolve({ items, nextCursor: null }));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-catalog",
          CATALOG_LIST_PRODUCTS_TOOL_NAME,
          "{}",
        ),
        mockTextStream("Base prices are ready for a +10% list."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List product prices" }],
      contracts: [listProducts],
      execute,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledWith(
      "catalog.listProducts",
      { status: "active", limit: 20 },
      { toolCallId: "call-catalog" },
    );
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain("basePriceMinor");
    expect(secondStep).toContain("UAH");
    expect(secondStep).not.toContain(imageId);
    expect(secondStep).not.toContain("primaryImageFileId");
    expect(secondStep).not.toContain(STAFF_ASSISTANT_CLIPPED_STATUS);
    expect(turn.toolResultBytesOut).toBe(turn.toolResultBytesIn);
  });

  it("feeds a compact customers page into the next step, not notes", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
      name: `Катя ${String(index)}`,
      phone: "+380501234567",
      email: `c${String(index)}@example.com`,
      userId: "user_secret_id",
      notes: "do not leak notes into the model",
      groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      priceListId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "active" as const,
      linkedCounterpartyCount: 2,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-02T08:00:00.000Z",
    }));
    const execute = vi.fn(() => Promise.resolve({ items, nextCursor: null }));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-customers",
          CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
          JSON.stringify({ search: "Катя" }),
        ),
        mockTextStream("Катя: +380501234567"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Find Katya" }],
      contracts: [listCustomers],
      execute,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledWith(
      "customers.listCustomers",
      {
        status: "active",
        search: "Катя",
        limit: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-customers" },
    );
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain("+380501234567");
    expect(secondStep).toContain("@example.com");
    expect(secondStep).not.toContain("do not leak notes into the model");
    expect(secondStep).not.toContain("user_secret_id");
    expect(secondStep).not.toContain(STAFF_ASSISTANT_CLIPPED_STATUS);
    expect(turn.toolResultBytesOut).toBe(turn.toolResultBytesIn);
  });

  it("feeds a compact groups page into the next step, not description", async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
      name: `VIP ${String(index)}`,
      slug: `vip-${String(index)}`,
      description: "do not leak group description",
      priceListId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      memberCount: 8,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-02T08:00:00.000Z",
    }));
    const execute = vi.fn(() => Promise.resolve({ items, nextCursor: null }));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-groups",
          CUSTOMERS_LIST_GROUPS_TOOL_NAME,
          JSON.stringify({ search: "VIP" }),
        ),
        mockTextStream("VIP has 8 members."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Find VIP group" }],
      contracts: [listGroups],
      execute,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledWith(
      "customers.listGroups",
      {
        search: "VIP",
        limit: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-groups" },
    );
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain("VIP 0");
    expect(secondStep).toContain('"memberCount":8');
    expect(secondStep).toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(secondStep).not.toContain("do not leak group description");
    expect(secondStep).not.toContain('"slug"');
    expect(secondStep).not.toContain(STAFF_ASSISTANT_CLIPPED_STATUS);
    expect(turn.toolResultBytesOut).toBe(turn.toolResultBytesIn);
  });

  it("eval: find price list named Opt uses one pricing list façade call with query", async () => {
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
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-pricing",
          PRICING_LIST_PRICE_LISTS_TOOL_NAME,
          JSON.stringify({ query: "Opt" }),
        ),
        mockTextStream("Found price list Opt."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "find price list named Opt" }],
      contracts: [listPriceLists],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "pricing.listPriceLists",
      { query: "Opt", availability: "all", limit: 20 },
      { toolCallId: "call-pricing" },
    );
    expect(turn.toolRuns).toEqual([
      {
        actionName: "pricing.listPriceLists",
        toolCallId: "call-pricing",
        resultIds: [],
        outcome: "success",
      },
    ]);
    const toolNames = (model.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(PRICING_LIST_PRICE_LISTS_TOOL_NAME);
    expect(toolNames).not.toContain(
      toProviderToolName("pricing.listPriceLists"),
    );
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain("Opt");
    expect(secondStep).toContain("entryCount");
    expect(JSON.stringify(payloads)).not.toMatch(
      /cannot find a tool|missing tool/i,
    );
  });

  it("eval: unique names create uses one orders_create façade call", async () => {
    const execute = vi.fn(() => Promise.resolve({ orderId: customerId }));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Katya",
            items: [{ productQuery: "Cake", quantityDecimal: "1.5" }],
          }),
        ),
        mockTextStream("Order created."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [
        { role: "user", content: "Create an order for Katya with Cake" },
      ],
      contracts: [createOrder],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "orders.create",
      {
        customer: { by: "query", value: "Katya" },
        items: [
          {
            product: { by: "query", value: "Cake" },
            quantity: { decimal: "1.5" },
            variantSelection: { kind: "unspecified" },
          },
        ],
      },
      { toolCallId: "call-create" },
    );
    expect(turn.toolRuns).toEqual([
      {
        actionName: "orders.create",
        toolCallId: "call-create",
        resultIds: [customerId],
        outcome: "success",
      },
    ]);
    const toolNames = (model.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(toolNames).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(toolNames).toContain(toProviderToolName("orders.create"));
    const secondStep = JSON.stringify(model.doStreamCalls[1]);
    expect(secondStep).toContain(customerId);
    expect(JSON.stringify(payloads)).not.toMatch(
      /cannot find a tool|missing tool/i,
    );
  });

  it("changes toolsetHash when the attached contract set changes", async () => {
    async function hashFor(
      contracts: Parameters<typeof streamStaffAssistantChat>[0]["contracts"],
    ): Promise<string> {
      const model = new MockLanguageModelV3({
        doStream: [mockTextStream("ok")],
      });
      const { response, completion } = streamStaffAssistantChat({
        model,
        messages: [{ role: "user", content: "Hi" }],
        contracts,
        execute: () => Promise.resolve({}),
      });
      await readUiMessageSsePayloads(response);
      return (await completion).toolsetHash;
    }

    const listOnly = await hashFor([listOrders]);
    const both = await hashFor([listOrders, deleteCustomer]);
    expect(listOnly).not.toBe(STAFF_ASSISTANT_EMPTY_TOOLSET_HASH);
    expect(both).not.toBe(listOnly);
  });

  it("pauses on ConfirmationRequiredError and streams a redacted confirmation part", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network must not run"));
    const summary =
      "Delete this archived customer. Confirm the name and primary contact.";
    const execute = vi.fn(() =>
      Promise.reject(
        new ConfirmationRequiredError({
          challengeId,
          summary,
          expiresAt: "2026-09-01T12:00:00.000Z",
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: customerId }),
        ),
        mockTextStream("should not auto-confirm"),
      ],
    });

    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Delete the customer" }],
      contracts: [deleteCustomer],
      execute,
    });

    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(turn.toolRuns).toEqual([
      {
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
        challengeId,
        resultIds: [],
        outcome: "confirmation_required",
      },
    ]);
    expect(turn.text).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    expect(JSON.stringify(payloads)).not.toContain("should not auto-confirm");

    const confirmationChunks = payloads.filter((payload) => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "data-confirmation"
      );
    });
    expect(confirmationChunks.length).toBeGreaterThanOrEqual(1);
    const first = confirmationChunks[0];
    expect(first).toMatchObject({
      type: "data-confirmation",
      data: {
        status: "confirmation_required",
        challengeId,
        summary,
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
      },
    });
    expect(
      isStaffAssistantConfirmationOutput(
        first !== undefined &&
          typeof first === "object" &&
          first !== null &&
          "data" in first
          ? first.data
          : undefined,
      ),
    ).toBe(true);
    expect(turn.text).not.toBe("Done.");
    expect(turn.text).not.toMatch(/action is done|action done/i);
    expect(JSON.stringify(payloads)).not.toContain("NoObjectGeneratedError");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("awaits onTurn after text and fails the stream when persist fails", async () => {
    const onTurn = vi.fn(() => Promise.reject(new Error("persist failed")));
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("You have no orders.")],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
      onTurn,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toContain("You have no orders.");
    expect(onTurn).toHaveBeenCalledOnce();
    expect(onTurn).toHaveBeenCalledWith(turn);
    expect(JSON.stringify(payloads)).toContain(
      "The assistant could not complete this turn.",
    );
  });

  it("flattens spoken after orders_list_page and keeps the tool part", async () => {
    const spoken = "Albina has 4 orders this week.";
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        items: [
          {
            orderId: customerId,
            orderNumber: "1049",
            status: "new",
          },
        ],
        nextCursor: null,
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Show Albina's orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    const payloadText = JSON.stringify(payloads);
    const presented = presentCompletedStaffAssistantTurn({
      locale: STAFF_ASSISTANT_DEFAULT_LOCALE,
      toolResults: [
        {
          toolName: ORDERS_LIST_PAGE_TOOL_NAME,
          output: {
            kind: "page.summary",
            items: [
              {
                orderId: customerId,
                orderNumber: "1049",
                status: "new",
              },
            ],
            nextCursor: null,
          },
        },
      ],
    });
    expect(presented).toBeDefined();
    expect(turn.text).toBe(presented);
    expect(turn.text).not.toBe(spoken);
    expect(turn.text).not.toContain("|");
    expect(turn.text).not.toContain("**");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(payloadText).not.toContain(spoken);
    expect(payloadText).not.toContain('{"spoken"');
    expect(payloadText).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(turn.toolRuns).toEqual([
      {
        actionName: "orders.list",
        toolCallId: "call-list",
        resultIds: [],
        outcome: "success",
      },
    ]);
  });

  it("flattens spoken after counts-only aggregate", async () => {
    const spoken = "6 orders this week, mostly confirmed.";
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "aggregate",
        orderCount: 6,
        grossByCurrency: [{ currency: "UAH", grossAmountMinor: "150000" }],
        buckets: [
          {
            identity: { kind: "status", status: "confirmed" },
            orderCount: 4,
            grossByCurrency: [],
          },
        ],
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-counts",
          ORDERS_LIST_COUNTS_TOOL_NAME,
          JSON.stringify({ period: "this_week" }),
        ),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "How many this week?" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    const payloadText = JSON.stringify(payloads);
    const presented = presentCompletedStaffAssistantTurn({
      locale: STAFF_ASSISTANT_DEFAULT_LOCALE,
      toolResults: [
        {
          toolName: ORDERS_LIST_COUNTS_TOOL_NAME,
          output: {
            kind: "aggregate",
            orderCount: 6,
            grossByCurrency: [{ currency: "UAH", grossAmountMinor: "150000" }],
            buckets: [
              {
                identity: { kind: "status", status: "confirmed" },
                orderCount: 4,
                grossByCurrency: [],
              },
            ],
          },
        },
      ],
    });
    expect(presented).toBeDefined();
    expect(turn.text).toBe(presented);
    expect(turn.text).not.toBe(spoken);
    expect(turn.text).not.toContain("|");
    expect(turn.text).not.toContain("**");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(payloadText).not.toContain(spoken);
    expect(payloadText).not.toContain('{"spoken"');
    expect(payloadText).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(turn.toolRuns).toEqual([
      {
        actionName: "orders.list",
        toolCallId: "call-counts",
        resultIds: [],
        outcome: "success",
      },
    ]);
  });

  it("does not record a synthetic json tool as a domain toolRun", async () => {
    const spoken = "Four orders this week.";
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockJsonToolAndSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolRuns.map((run) => run.actionName)).toEqual(["orders.list"]);
    expect(turn.toolRuns.map((run) => run.toolCallId)).not.toContain(
      "call-json",
    );
    expect(turn.text).toBe("Немає замовлень.");
    expect(turn.text).not.toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain(spoken);
    expect(JSON.stringify(payloads)).not.toContain(
      `"toolName":"${STAFF_ASSISTANT_SYNTHETIC_JSON_TOOL_NAME}"`,
    );
  });

  it("fail-opens a markdown table spoken line after a successful list", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream("| order | total |\n| **#1** | 10 |"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("Немає замовлень.");
    expect(turn.text).not.toBe("Done.");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("|");
    expect(turn.toolRuns[0]?.outcome).toBe("success");
  });

  it("fail-opens a non-JSON markdown table after a successful list", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("| order | total |"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    const payloadText = JSON.stringify(payloads);
    expect(turn.text).toBe("Немає замовлень.");
    expect(turn.text).not.toBe("Done.");
    expect(turn.text).not.toContain("|");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(payloadText).not.toContain("|");
    expect(payloadText).not.toContain(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
    expect(turn.toolRuns[0]?.outcome).toBe("success");
  });

  it("keeps the confirmation fallback when a successful list and HITL share a markdown spoken turn", async () => {
    const summary =
      "Delete this archived customer. Confirm the name and primary contact.";
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.deleteCustomer") {
        return Promise.reject(
          new ConfirmationRequiredError({
            challengeId,
            summary,
            expiresAt: "2026-09-01T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockToolCallAndSpokenStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: customerId }),
          "| order | total |\n| **#1** | 10 |",
        ),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [
        { role: "user", content: "List orders then delete the customer" },
      ],
      contracts: [listOrders, deleteCustomer],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    const payloadText = JSON.stringify(payloads);
    expect(turn.toolRuns.map((run) => run.outcome)).toEqual([
      "success",
      "confirmation_required",
    ]);
    expect(turn.text).toBe(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    expect(turn.text).not.toBe(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
    expect(turn.text).not.toBe("Done.");
    expect(turn.text).not.toMatch(/action is done|action done/i);
    expect(payloadText).not.toContain(STAFF_ASSISTANT_SUCCESS_SPOKEN_FALLBACK);
    expect(payloadText).not.toContain("| order");
    expect(payloadText).not.toContain("NoObjectGeneratedError");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(payloadText).toContain(STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT);
    const confirmationChunks = payloads.filter((payload) => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "data-confirmation"
      );
    });
    expect(confirmationChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("persists presenter text for a list tool, not mock model spoken", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const page = {
      kind: "page.summary" as const,
      items: [
        {
          orderId: customerId,
          orderNumber: "1049",
          status: "new" as const,
        },
      ],
      nextCursor: null,
    };
    const execute = vi.fn(() => Promise.resolve(page));
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Show the last orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("Останні замовлення: #1049 (Нове).");
    expect(turn.text).not.toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain(spoken);
  });

  it("persists English presenter text when locale is en", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "page.summary",
        items: [
          {
            orderId: customerId,
            orderNumber: "1049",
            status: "new",
          },
        ],
        nextCursor: null,
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Show the last orders" }],
      contracts: [listOrders],
      execute,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("Latest orders: #1049 (New).");
    expect(turn.text).not.toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain(spoken);
  });

  it("defaults presenter locale to uk when omitted", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream("MODEL_SPOKEN"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("Немає замовлень.");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("MODEL_SPOKEN");
  });

  it("persists model spoken when there is no registered surface", async () => {
    const spoken = "I can look up orders when you ask.";
    const model = new MockLanguageModelV3({
      doStream: [mockSpokenStream(spoken)],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Hello" }],
      contracts: [listOrders],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(turn.toolRuns).toEqual([]);
  });

  it("persists presenter text for an entity tool, not mock model spoken", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const execute = vi.fn(() =>
      Promise.resolve({
        orderId: customerId,
        orderNumber: "1049",
        status: "new",
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-get",
          toProviderToolName("orders.get"),
          JSON.stringify({ orderId: customerId }),
        ),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Open the order" }],
      contracts: [getOrder],
      execute,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("Order #1049, New.");
    expect(turn.text).not.toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain(spoken);
  });

  it("joins multiple registered surfaces in tool-result order", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_PERSIST";
    const execute = vi.fn((actionName: string) => {
      if (actionName === "orders.get") {
        return Promise.resolve({
          orderId: customerId,
          orderNumber: "1049",
          status: "new",
        });
      }
      return Promise.resolve({
        kind: "page.summary",
        items: [
          {
            orderId: customerId,
            orderNumber: "1050",
            status: "confirmed",
          },
        ],
        nextCursor: null,
      });
    });
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-get",
          toProviderToolName("orders.get"),
          JSON.stringify({ orderId: customerId }),
        ),
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Show that order and the list" }],
      contracts: [listOrders, getOrder],
      execute,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe(
      "Order #1049, New.\nLatest orders: #1050 (Confirmed).",
    );
    expect(turn.text).not.toBe(spoken);
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain(spoken);
  });

  it("attaches only the forced job tool with toolChoice required", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream("should not need a second tool"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "show last 3 orders" }],
      contracts: [listOrders, deleteCustomer, createOrder],
      execute,
      forcedToolName: ORDERS_LIST_PAGE_TOOL_NAME,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    const first = model.doStreamCalls[0];
    const names = (first?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual([ORDERS_LIST_PAGE_TOOL_NAME]);
    expect(names).not.toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).not.toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).not.toContain(ORDERS_CREATE_TOOL_NAME);
    expect(first?.toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(turn.toolsAttached).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fail-opens to the full catalog when the forced job tool is missing", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("You have no orders.")],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "show last 3 orders" }],
      contracts: [deleteCustomer, listProducts, createOrder],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
      forcedToolName: ORDERS_LIST_PAGE_TOOL_NAME,
    });
    await readUiMessageSsePayloads(response);
    const turn = await completion;
    const first = model.doStreamCalls[0];
    const names = (first?.tools ?? []).map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).toContain(CATALOG_LIST_PRODUCTS_TOOL_NAME);
    expect(names).toContain(ORDERS_CREATE_TOOL_NAME);
    expect(names).toContain(toProviderToolName("customers.deleteCustomer"));
    expect(names).not.toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).not.toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(first?.toolChoice).not.toEqual({ type: "required" });
    expect(first?.toolChoice).toEqual({ type: "auto" });
    expect(turn.toolsAttached).toBe(true);
  });

  it("stops after needs_choice and does not force a second presentation tool", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        status: "needs_choice",
        challengeId: customerId,
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Cake", quantityDecimal: "1" }],
          }),
        ),
        mockToolCallStream("call-present", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
      ],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for macarons" }],
      contracts: [listOrders, createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
    });
    await readUiMessageSsePayloads(response);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  class DuckTypedPickerConflict extends ConflictError {
    readonly reason: string;
    readonly target: {
      readonly lineIndex: number;
      readonly productId: string;
      readonly productName: string;
    };
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly optionsTruncated: boolean;

    constructor(args: {
      readonly reason: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
      }[];
      readonly optionsTruncated?: boolean;
    }) {
      super('Select a variant for "Macarons".');
      this.reason = args.reason;
      this.target = {
        lineIndex: 0,
        productId: customerId,
        productName: "Macarons",
      };
      this.options = args.options;
      this.optionsTruncated = args.optionsTruncated ?? false;
    }
  }

  class DuckTypedProductConflict extends ConflictError {
    readonly reason = "ambiguous" as const;
    readonly target: {
      readonly kind: "order_line_product";
      readonly lineIndex: number;
      readonly query: string;
    };
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly optionsTruncated: boolean;

    constructor(args: {
      readonly query: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
      }[];
      readonly optionsTruncated?: boolean;
    }) {
      super(`Select a product matching "${args.query}".`);
      this.target = {
        kind: "order_line_product",
        lineIndex: 0,
        query: args.query,
      };
      this.options = args.options;
      this.optionsTruncated = args.optionsTruncated ?? false;
    }
  }

  class DuckTypedCustomerConflict extends ConflictError {
    readonly reason = "ambiguous" as const;
    readonly target: { readonly kind: "customer"; readonly query: string };
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly optionsTruncated: boolean;

    constructor(args: {
      readonly query: string;
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
      }[];
      readonly optionsTruncated?: boolean;
    }) {
      super(`Select a customer matching "${args.query}".`);
      this.target = { kind: "customer", query: args.query };
      this.options = args.options;
      this.optionsTruncated = args.optionsTruncated ?? false;
    }
  }

  class DuckTypedArchivedConflict extends ConflictError {
    readonly reason = "archived" as const;
    readonly target: {
      readonly kind: "order_line_product";
      readonly lineIndex: number;
      readonly query: string;
      readonly productName?: string;
    };
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[] = [];
    readonly optionsTruncated = false;

    constructor(args: {
      readonly query?: string;
      readonly productName?: string;
    }) {
      super(
        args.productName !== undefined
          ? `"${args.productName}" is archived.`
          : `No active product matched "${args.query ?? "cupcake"}"; matching products are archived.`,
      );
      this.target =
        args.productName === undefined
          ? {
              kind: "order_line_product",
              lineIndex: 0,
              query: args.query ?? "cupcake",
            }
          : {
              kind: "order_line_product",
              lineIndex: 0,
              query: args.query ?? args.productName,
              productName: args.productName,
            };
    }
  }

  const lemonVariant = "55555555-5555-4555-8555-555555555555";
  const vanillaVariant = "66666666-6666-4666-8666-666666666666";
  const pickerOptions = [
    { id: lemonVariant, label: "Lemon" },
    { id: vanillaVariant, label: "Vanilla" },
  ];

  it("maps a duck-typed CONFLICT extras object to needs_choice rather than error", async () => {
    const opened: unknown[] = [];
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedPickerConflict({
          reason: "variant_required",
          options: pickerOptions,
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
          }),
        ),
        mockToolCallStream("call-present", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for macarons" }],
      contracts: [listOrders, createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
      choiceBind: {
        actorId: "anna",
        companyId: customerId,
        conversationId: challengeId,
      },
      openChoice: (record) => {
        opened.push(record);
        return Promise.resolve(true);
      },
      mintChoiceId: () => challengeId,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(turn.toolRuns[0]?.outcome).toBe("choice_required");
    expect(turn.toolRuns[0]?.challengeId).toBe(challengeId);
    expect(opened).toHaveLength(1);
    expect(JSON.stringify(opened[0])).toContain("canonicalInput");
    const choiceChunks = payloads.filter((payload) => {
      return (
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "data-choice"
      );
    });
    expect(choiceChunks.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(choiceChunks)).toContain("needs_choice");
    expect(JSON.stringify(choiceChunks)).not.toContain("canonicalInput");
    expect(JSON.stringify(choiceChunks)).not.toContain("optionMap");
    expect(turn.text).toContain("Macarons");
    expect(turn.text).toContain("Lemon");
  });

  it("forwards optionsTruncated on a two-option picker so the prefix is not the full set", async () => {
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedPickerConflict({
          reason: "variant_required",
          options: pickerOptions,
          optionsTruncated: true,
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
          }),
        ),
        mockToolCallStream("call-present", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for macarons" }],
      contracts: [listOrders, createOrder],
      execute,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(payloads)).toContain('"optionsTruncated":true');
    expect(turn.text).toContain(CHOICE_TRUNCATED_COPY.en);
    expect(turn.text).toContain("Lemon");
    expect(turn.text).toContain("Vanilla");
  });

  it("forwards product and customer choiceKind on live data-choice with match truncated copy", async () => {
    const productIdA = "77777777-7777-4777-8777-777777777777";
    const productIdB = "88888888-8888-4888-8888-888888888888";
    const customerTwinA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const customerTwinB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cases = [
      {
        kind: "product" as const,
        spoken: "Select a product matching макаронс:",
        input: {
          customerQuery: "Леха",
          items: [{ productQuery: "макаронс", quantityDecimal: "10" }],
        },
        error: new DuckTypedProductConflict({
          query: "макаронс",
          options: [
            { id: productIdA, label: "Макаронси" },
            { id: productIdB, label: "Macarons" },
          ],
          optionsTruncated: true,
        }),
      },
      {
        kind: "customer" as const,
        spoken: "Select a customer matching Katya:",
        input: {
          customerQuery: "Katya",
          items: [{ productQuery: "Cake", quantityDecimal: "1" }],
        },
        error: new DuckTypedCustomerConflict({
          query: "Katya",
          options: [
            { id: customerTwinA, label: "Katya (…2233)" },
            { id: customerTwinB, label: "Katya (…5566)" },
          ],
          optionsTruncated: true,
        }),
      },
    ];
    for (const testCase of cases) {
      const execute = vi.fn(() => Promise.reject(testCase.error));
      const model = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify(testCase.input),
          ),
        ],
      });
      const { response, completion } = streamStaffAssistantChat({
        model,
        messages: [{ role: "user", content: "create an order" }],
        contracts: [createOrder],
        execute,
        locale: "en",
      });
      const payloads = await readUiMessageSsePayloads(response);
      const turn = await completion;
      const choiceChunks = payloads.filter((payload) => {
        return (
          typeof payload === "object" &&
          payload !== null &&
          "type" in payload &&
          payload.type === "data-choice"
        );
      });
      expect(choiceChunks.length).toBeGreaterThanOrEqual(1);
      const envelope = choiceChunks
        .map((chunk) => {
          if (!isRecord(chunk) || !isRecord(chunk.data)) {
            return undefined;
          }
          return chunk.data;
        })
        .find((data) => data !== undefined);
      expect(envelope?.choiceKind).toBe(testCase.kind);
      expect(turn.toolRuns[0]?.outcome).toBe("choice_required");
      expect(turn.text).toContain(testCase.spoken);
      expect(turn.text).not.toContain("Select a variant");
      expect(turn.text).toContain(CHOICE_TRUNCATED_MATCH_COPY.en);
      expect(turn.text).not.toContain(CHOICE_TRUNCATED_COPY.en);
    }
  });

  it("returns an ordinary error when openChoice SET NX fails", async () => {
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedPickerConflict({
          reason: "variant_required",
          options: pickerOptions,
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
          }),
        ),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create macarons" }],
      contracts: [createOrder],
      execute,
      choiceBind: {
        actorId: "anna",
        companyId: customerId,
        conversationId: challengeId,
      },
      openChoice: () => Promise.resolve(false),
      mintChoiceId: () => challengeId,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolRuns[0]?.outcome).toBe("error");
    expect(JSON.stringify(payloads)).not.toContain("data-choice");
    expect(JSON.stringify(payloads)).not.toContain("needs_choice");
  });

  it("stops after a full needs_choice envelope without a forced tool", async () => {
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedPickerConflict({
          reason: "variant_required",
          options: pickerOptions,
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
          }),
        ),
        mockToolCallStream("call-present", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for macarons" }],
      contracts: [listOrders, createOrder],
      execute,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(turn.toolRuns[0]?.outcome).toBe("choice_required");
    expect(JSON.stringify(payloads)).toContain("data-choice");
    expect(JSON.stringify(payloads)).toContain("needs_choice");
    expect(JSON.stringify(payloads)).toContain("Lemon");
  });

  it("maps unmatched_query and ambiguous CONFLICT extras to needs_choice", async () => {
    for (const reason of ["unmatched_query", "ambiguous"] as const) {
      const execute = vi.fn(() =>
        Promise.reject(
          new DuckTypedPickerConflict({
            reason,
            options: pickerOptions,
          }),
        ),
      );
      const model = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            JSON.stringify({
              customerQuery: "Леха",
              items: [
                {
                  productQuery: "Macarons",
                  variantQuery:
                    reason === "unmatched_query" ? "Pistachio" : "e",
                  quantityDecimal: "1",
                },
              ],
            }),
          ),
        ],
      });
      const { response, completion } = streamStaffAssistantChat({
        model,
        messages: [{ role: "user", content: "create macarons" }],
        contracts: [createOrder],
        execute,
        forcedToolName: ORDERS_CREATE_TOOL_NAME,
      });
      const payloads = await readUiMessageSsePayloads(response);
      const turn = await completion;
      expect(turn.toolRuns[0]?.outcome).toBe("choice_required");
      expect(JSON.stringify(payloads)).toContain("data-choice");
      expect(JSON.stringify(payloads)).not.toContain('"status":"error"');
    }
  });

  it("maps no_active_variants CONFLICT to an error envelope, not a ChoiceCard", async () => {
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedPickerConflict({
          reason: "no_active_variants",
          options: [],
        }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
          }),
        ),
        mockSpokenStream("That product has no active variants."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create macarons" }],
      contracts: [createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolRuns[0]?.outcome).toBe("error");
    expect(JSON.stringify(payloads)).not.toContain("data-choice");
    expect(JSON.stringify(payloads)).not.toContain("needs_choice");
  });

  it("maps archived CONFLICT to an error envelope, not a ChoiceCard", async () => {
    const execute = vi.fn(() =>
      Promise.reject(
        new DuckTypedArchivedConflict({ productName: "Old Widget" }),
      ),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Old Widget", quantityDecimal: "1" }],
          }),
        ),
        mockSpokenStream("That product is archived."),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create archived widget" }],
      contracts: [createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.toolRuns[0]?.outcome).toBe("error");
    expect(JSON.stringify(payloads)).not.toContain("data-choice");
    expect(JSON.stringify(payloads)).not.toContain("needs_choice");
  });

  it("streams presenter copy for archived and no_active_variants, not model spoken", async () => {
    const spoken = "MODEL_SPOKEN_SHOULD_NOT_FLASH";
    const cases = [
      {
        error: new DuckTypedArchivedConflict({ productName: "Old Widget" }),
        extras: {
          reason: "archived" as const,
          subject: { kind: "product_name" as const, name: "Old Widget" },
        },
        productQuery: "Old Widget",
      },
      {
        error: new DuckTypedArchivedConflict({ query: "ZzzArchiveTwin" }),
        extras: {
          reason: "archived" as const,
          subject: { kind: "query" as const, query: "ZzzArchiveTwin" },
        },
        productQuery: "ZzzArchiveTwin",
      },
      {
        error: new DuckTypedPickerConflict({
          reason: "no_active_variants",
          options: [],
        }),
        extras: {
          reason: "no_active_variants" as const,
          subject: { kind: "product_name" as const, name: "Macarons" },
        },
        productQuery: "Macarons",
      },
    ];
    for (const locale of ["uk", "en"] as const) {
      for (const fixture of cases) {
        const execute = vi.fn(() => Promise.reject(fixture.error));
        const model = new MockLanguageModelV3({
          doStream: [
            mockToolCallStream(
              "call-create",
              ORDERS_CREATE_TOOL_NAME,
              JSON.stringify({
                customerQuery: "Леха",
                items: [
                  {
                    productQuery: fixture.productQuery,
                    quantityDecimal: "1",
                  },
                ],
              }),
            ),
            mockSpokenStream(spoken),
          ],
        });
        const { response, completion } = streamStaffAssistantChat({
          model,
          messages: [{ role: "user", content: "create" }],
          contracts: [createOrder],
          execute,
          forcedToolName: ORDERS_CREATE_TOOL_NAME,
          locale,
        });
        const payloads = await readUiMessageSsePayloads(response);
        const turn = await completion;
        const expected = presentCatalogDomainError({
          locale,
          extras: fixture.extras,
        });
        expect(turn.toolRuns[0]?.outcome).toBe("error");
        expect(turn.text).toBe(expected);
        expect(turn.text).not.toBe(spoken);
        expect(turn.text).not.toBe(fixture.error.clientMessage);
        expect(sseVisibleTextFromPayloads(payloads)).toBe(expected);
        expect(JSON.stringify(payloads)).not.toContain(spoken);
        expect(JSON.stringify(payloads)).not.toContain("data-choice");
        expect(JSON.stringify(payloads)).not.toContain("needs_choice");
      }
    }
  });

  it("attaches only orders_list_counts when that job is forced", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: "aggregate",
        orderCount: 0,
        buckets: [],
        grossByCurrency: [],
        statusBuckets: [],
      }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-counts", ORDERS_LIST_COUNTS_TOOL_NAME, "{}"),
      ],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "how many orders today" }],
      contracts: [listOrders, createOrder],
      execute,
      forcedToolName: ORDERS_LIST_COUNTS_TOOL_NAME,
    });
    await readUiMessageSsePayloads(response);
    const names = (model.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([ORDERS_LIST_COUNTS_TOOL_NAME]);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "required" });
  });

  it("attaches only orders_create when that job is forced", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ orderId: customerId, orderNumber: "1" }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "Cake", quantityDecimal: "1" }],
          }),
        ),
      ],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for Леха" }],
      contracts: [listOrders, createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
    });
    await readUiMessageSsePayloads(response);
    const names = (model.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([ORDERS_CREATE_TOOL_NAME]);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "required" });
  });

  it("fail-open without a forced tool attaches the current full toolset", async () => {
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("You have no orders.")],
    });
    const { response } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders, deleteCustomer],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    await readUiMessageSsePayloads(response);
    const names = (model.doStreamCalls[0]?.tools ?? []).map(
      (tool) => tool.name,
    );
    expect(names).toContain(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    expect(names).toContain(ORDERS_LIST_PAGE_TOOL_NAME);
    expect(names).toContain(ORDERS_LIST_COUNTS_TOOL_NAME);
    expect(names).toContain(toProviderToolName("customers.deleteCustomer"));
    expect(names.length).toBeGreaterThan(1);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "auto" });
  });

  const macaronsConflictMessage =
    'Multiple matches for "макаронс": Макаронси (UAH, 11111111-1111-4111-8111-111111111111).';
  const unknownProductMessage = 'No product matches "xyzzy".';
  const ordersCreateMacaronsInput = JSON.stringify({
    customerQuery: "Леха",
    items: [{ productQuery: "макаронс", quantityDecimal: "10" }],
  });

  it("does not stop a forced create on CONFLICT; recovery is speech-only", async () => {
    const execute = vi.fn(() =>
      Promise.reject(new ConflictError(macaronsConflictMessage)),
    );
    const spoken = "Не знайшла той товар. Уточніть назву.";
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          ordersCreateMacaronsInput,
        ),
        mockSpokenStream(spoken),
        mockToolCallStream("call-retry", CATALOG_LIST_PRODUCTS_TOOL_NAME, "{}"),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [
        { role: "user", content: "Створи замовлення для Леха 10 макаронс" },
      ],
      contracts: [listOrders, createOrder, listProducts],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
      locale: "uk",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0]?.toolChoice).toEqual({ type: "required" });
    expect(model.doStreamCalls[1]?.toolChoice).toEqual({ type: "none" });
    expect(turn.toolRuns[0]?.outcome).toBe("error");
    expect(turn.text).toBe(spoken);
    expect(turn.text).not.toBe("Done.");
    expect(turn.text).not.toBe("");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
    expect(JSON.stringify(payloads)).not.toContain("needs_choice");
    expect(turn.modelSteps).toBeLessThan(STAFF_ASSISTANT_MAX_STEPS);
  });

  it("uses the typed CONFLICT message when recovery has no spoken", async () => {
    for (const locale of ["uk", "en"] as const) {
      const execute = vi.fn(() =>
        Promise.reject(new ConflictError(macaronsConflictMessage)),
      );
      const model = new MockLanguageModelV3({
        doStream: [
          mockToolCallStream(
            "call-create",
            ORDERS_CREATE_TOOL_NAME,
            ordersCreateMacaronsInput,
          ),
          mockTextStream(""),
        ],
      });
      const { response, completion } = streamStaffAssistantChat({
        model,
        messages: [
          { role: "user", content: "Створи замовлення для Леха 10 макаронс" },
        ],
        contracts: [createOrder],
        execute,
        forcedToolName: ORDERS_CREATE_TOOL_NAME,
        locale,
      });
      const payloads = await readUiMessageSsePayloads(response);
      const turn = await completion;
      expect(turn.toolRuns[0]?.outcome).toBe("error");
      expect(turn.text).toBe(macaronsConflictMessage);
      expect(turn.text).not.toBe("Done.");
      expect(turn.text).not.toBe(STAFF_ASSISTANT_TOOL_ERROR_FALLBACK);
      expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
      expect(sseVisibleTextFromPayloads(payloads).length).toBeGreaterThan(0);
    }
  });

  it("does not stop a forced create on NOT_FOUND; recovery is speech-only", async () => {
    const execute = vi.fn(() =>
      Promise.reject(new NotFoundError(unknownProductMessage)),
    );
    const spoken = "That name is not a product in this company.";
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "xyzzy", quantityDecimal: "1" }],
          }),
        ),
        mockSpokenStream(spoken),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for xyzzy" }],
      contracts: [createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.toolChoice).toEqual({ type: "none" });
    expect(turn.toolRuns[0]?.outcome).toBe("error");
    expect(turn.text).toBe(spoken);
    expect(turn.text).not.toBe("Done.");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
  });

  it("uses the typed NOT_FOUND message when recovery has no spoken", async () => {
    const execute = vi.fn(() =>
      Promise.reject(new NotFoundError(unknownProductMessage)),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream(
          "call-create",
          ORDERS_CREATE_TOOL_NAME,
          JSON.stringify({
            customerQuery: "Леха",
            items: [{ productQuery: "xyzzy", quantityDecimal: "1" }],
          }),
        ),
        mockTextStream(""),
      ],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "create an order for xyzzy" }],
      contracts: [createOrder],
      execute,
      forcedToolName: ORDERS_CREATE_TOOL_NAME,
      locale: "en",
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe(unknownProductMessage);
    expect(turn.text).not.toBe("Done.");
    expect(sseVisibleTextFromPayloads(payloads)).toBe(turn.text);
  });
});
