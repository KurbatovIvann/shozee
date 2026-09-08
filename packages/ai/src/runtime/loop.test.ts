import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineActionContract } from "@showzy/core/contract";
import { ConfirmationRequiredError, ConflictError } from "@showzy/core/errors";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CATALOG_LIST_PRODUCTS_TOOL_NAME,
  ORDERS_CREATE_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  toProviderToolName,
} from "../action-tool.js";
import { STAFF_ASSISTANT_CONFIRMATION_COPY } from "../confirmation.js";
import {
  MockLanguageModelV3,
  mockSpokenStream,
  mockTextStream,
  mockToolCallAndSpokenStream,
  mockToolCallStream,
  mockToolCallsStream,
} from "../test.js";
import { ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT } from "../tool-facades/orders-list.js";
import { STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK } from "../turn-speech.js";
import { HOST_HITL_PAUSED_STATUS } from "./execute.js";
import { runStaffAssistantHostTurn } from "./loop.js";

const here = dirname(fileURLToPath(import.meta.url));

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

class DuckTypedPickerConflict extends ConflictError {
  readonly reason: "variant_required";
  readonly target: {
    readonly lineIndex: number;
    readonly productId: string;
    readonly productName: string;
  };
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly optionsTruncated: boolean;

  constructor(args: {
    readonly reason: "variant_required";
    readonly options: readonly {
      readonly id: string;
      readonly label: string;
    }[];
  }) {
    super('Select a variant for "Macarons".');
    this.reason = args.reason;
    this.target = {
      lineIndex: 0,
      productId: customerId,
      productName: "Macarons",
    };
    this.options = args.options;
    this.optionsTruncated = false;
  }
}

describe("runStaffAssistantHostTurn", () => {
  it("does not import the gate or the live speaker", () => {
    const src = readFileSync(join(here, "loop.ts"), "utf8");
    expect(src).not.toContain("classifyStaffAssistantTurn");
    expect(src).not.toContain("commitTurnSpeech");
    expect(src).not.toContain("generateText");
    expect(src).not.toContain('from "../gate.js"');
    expect(src).toContain("commitHostSpeech");
    expect(src).toContain("streamText");
    const stream = readFileSync(
      join(here, "../staff-assistant-stream.ts"),
      "utf8",
    );
    expect(stream).not.toContain("runStaffAssistantHostTurn");
    expect(stream).not.toContain("runtime/loop");
  });

  it("persists usable model prose", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("You have no orders."),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    expect(execute).toHaveBeenCalledWith(
      "orders.list",
      { kind: "page.summary", limit: ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT },
      { toolCallId: "call-list" },
    );
    expect(turn.speech).toEqual({
      source: "model",
      text: "You have no orders.",
    });
    expect(turn.text).toBe("You have no orders.");
    expect(turn.modelToolCalls).toEqual([
      {
        toolCallId: "call-list",
        toolName: ORDERS_LIST_PAGE_TOOL_NAME,
        input: { limit: ORDERS_LIST_PAGE_ASSISTANT_DEFAULT_LIMIT },
      },
    ]);
  });

  it("falls back when leftover JSON makes text unusable", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockSpokenStream("Albina has 4 orders this week."),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
      locale: "en",
    });
    expect(turn.speech).toEqual({
      source: "fallback",
      text: STAFF_ASSISTANT_SUCCESS_SPEECH_FALLBACK.en,
    });
    expect(turn.text).not.toBe("Albina has 4 orders this week.");
  });

  it("keeps **#123** and does not fall back for a markdown table", async () => {
    const table = "| order | total |\n| **#123** | 10 |";
    const execute = vi.fn(() =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const emphasis = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-list", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream("Created **#123**."),
      ],
    });
    const emphasisTurn = await runStaffAssistantHostTurn({
      model: emphasis,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    expect(emphasisTurn.speech).toEqual({
      source: "model",
      text: "Created **#123**.",
    });
    const tableModel = new MockLanguageModelV3({
      doStream: [
        mockToolCallStream("call-table", ORDERS_LIST_PAGE_TOOL_NAME, "{}"),
        mockTextStream(table),
      ],
    });
    const tableTurn = await runStaffAssistantHostTurn({
      model: tableModel,
      messages: [{ role: "user", content: "List orders" }],
      contracts: [listOrders],
      execute,
    });
    expect(tableTurn.speech).toEqual({ source: "model", text: table });
  });

  it("runs tools in one step sequentially and checks pending before each execute", async () => {
    const order: string[] = [];
    let releaseList: () => void = () => {
      // filled when the first execute starts
    };
    const listHold = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const execute = vi.fn(async (actionName: string) => {
      order.push(`start:${actionName}`);
      if (actionName === "orders.list") {
        await listHold;
      }
      order.push(`end:${actionName}`);
      return { items: [], nextCursor: null };
    });
    const pendingCalls: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallsStream([
          {
            toolCallId: "call-list",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            input: "{}",
          },
          {
            toolCallId: "call-products",
            toolName: CATALOG_LIST_PRODUCTS_TOOL_NAME,
            input: "{}",
          },
        ]),
        mockTextStream("Listed both."),
      ],
    });
    const turnPromise = runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "List orders and products" }],
      contracts: [listOrders, listProducts],
      execute,
      checkPending: () => {
        pendingCalls.push("check");
        return Promise.resolve({ allow: true });
      },
    });
    await vi.waitFor(() => {
      expect(order).toContain("start:orders.list");
    });
    expect(order).not.toContain("start:catalog.listProducts");
    expect(pendingCalls).toEqual(["check"]);
    releaseList();
    const turn = await turnPromise;
    expect(order).toEqual([
      "start:orders.list",
      "end:orders.list",
      "start:catalog.listProducts",
      "end:catalog.listProducts",
    ]);
    expect(pendingCalls).toEqual(["check", "check"]);
    expect(turn.speech.source).toBe("model");
  });

  it("stops further tools after confirmation_required and still commits narration", async () => {
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.deleteCustomer") {
        return Promise.reject(
          new ConfirmationRequiredError({
            challengeId,
            summary: "Delete this archived customer.",
            expiresAt: "2026-09-01T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallsStream([
          {
            toolCallId: "call-delete",
            toolName: toProviderToolName("customers.deleteCustomer"),
            input: JSON.stringify({ id: customerId }),
          },
          {
            toolCallId: "call-list",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            input: "{}",
          },
        ]),
        mockTextStream("Please confirm deleting this customer."),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "Delete the customer then list" }],
      contracts: [deleteCustomer, listOrders],
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      "customers.deleteCustomer",
      { id: customerId },
      { toolCallId: "call-delete" },
    );
    expect(turn.modelToolCalls).toEqual([
      {
        toolCallId: "call-delete",
        toolName: toProviderToolName("customers.deleteCustomer"),
        input: { id: customerId },
      },
    ]);
    expect(turn.modelToolCalls.map((call) => call.toolCallId)).not.toContain(
      "call-list",
    );
    expect(turn.toolRuns).toEqual([
      {
        actionName: "customers.deleteCustomer",
        toolCallId: "call-delete",
        challengeId,
        resultIds: [],
        outcome: "confirmation_required",
      },
    ]);
    expect(turn.speech).toEqual({
      source: "model",
      text: "Please confirm deleting this customer.",
    });
    expect(turn.text).not.toBe(STAFF_ASSISTANT_CONFIRMATION_COPY.uk);
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const narrationStep = JSON.stringify(model.doStreamCalls[1]);
    expect(narrationStep).toContain(HOST_HITL_PAUSED_STATUS);
    expect(narrationStep).not.toContain('"INTERNAL"');
  });

  it("commits HITL narration from a later step when the tool step is leftover JSON", async () => {
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.deleteCustomer") {
        return Promise.reject(
          new ConfirmationRequiredError({
            challengeId,
            summary: "Delete this archived customer.",
            expiresAt: "2026-09-01T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const narration = "Please confirm deleting this customer.";
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallAndSpokenStream(
          "call-delete",
          toProviderToolName("customers.deleteCustomer"),
          JSON.stringify({ id: customerId }),
          "ignored leftover spoken",
        ),
        mockTextStream(narration),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "Delete the customer" }],
      contracts: [deleteCustomer],
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(turn.speech).toEqual({ source: "model", text: narration });
    expect(turn.text).toBe(narration);
  });

  it("stops further tools after needs_choice and still commits narration", async () => {
    const lemonVariant = "55555555-5555-4555-8555-555555555555";
    const vanillaVariant = "66666666-6666-4666-8666-666666666666";
    const execute = vi.fn((actionName: string) => {
      if (actionName === "orders.create") {
        return Promise.reject(
          new DuckTypedPickerConflict({
            reason: "variant_required",
            options: [
              { id: lemonVariant, label: "Lemon" },
              { id: vanillaVariant, label: "Vanilla" },
            ],
          }),
        );
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallsStream([
          {
            toolCallId: "call-create",
            toolName: ORDERS_CREATE_TOOL_NAME,
            input: JSON.stringify({
              customerQuery: "Леха",
              items: [{ productQuery: "Macarons", quantityDecimal: "1" }],
            }),
          },
          {
            toolCallId: "call-list",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            input: "{}",
          },
        ]),
        mockTextStream("Pick a variant for Macarons."),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "create an order for macarons" }],
      contracts: [createOrder, listOrders],
      execute,
      choiceBind: {
        actorId: "anna",
        companyId: customerId,
        conversationId: challengeId,
      },
      openChoice: () => Promise.resolve(true),
      mintChoiceId: () => challengeId,
      locale: "en",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(turn.toolRuns[0]?.outcome).toBe("choice_required");
    expect(turn.speech).toEqual({
      source: "model",
      text: "Pick a variant for Macarons.",
    });
  });

  it("records a returned confirmation_required payload, not success", async () => {
    const execute = vi.fn((actionName: string) => {
      if (actionName === "customers.deleteCustomer") {
        return Promise.resolve({
          status: "confirmation_required" as const,
          challengeId,
          summary: "Delete this archived customer.",
          expiresAt: "2026-09-01T12:00:00.000Z",
          actionName: "customers.deleteCustomer",
          toolCallId: "call-delete",
        });
      }
      return Promise.resolve({ items: [], nextCursor: null });
    });
    const model = new MockLanguageModelV3({
      doStream: [
        mockToolCallsStream([
          {
            toolCallId: "call-delete",
            toolName: toProviderToolName("customers.deleteCustomer"),
            input: JSON.stringify({ id: customerId }),
          },
          {
            toolCallId: "call-list",
            toolName: ORDERS_LIST_PAGE_TOOL_NAME,
            input: "{}",
          },
        ]),
        mockTextStream("Please confirm deleting this customer."),
      ],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "Delete the customer then list" }],
      contracts: [deleteCustomer, listOrders],
      execute,
    });
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
    expect(turn.toolRuns[0]?.outcome).not.toBe("success");
    expect(model.doStreamCalls.length).toBeGreaterThanOrEqual(2);
    const narrationStep = JSON.stringify(model.doStreamCalls[1]);
    expect(narrationStep).toContain(HOST_HITL_PAUSED_STATUS);
    expect(narrationStep).not.toContain('"INTERNAL"');
  });

  it("does not call generateText (gate) during a host turn", async () => {
    const loopSrc = readFileSync(join(here, "loop.ts"), "utf8");
    const executeSrc = readFileSync(join(here, "execute.ts"), "utf8");
    const speechSrc = readFileSync(join(here, "speech.ts"), "utf8");
    for (const src of [loopSrc, executeSrc, speechSrc]) {
      expect(src).not.toContain("generateText");
      expect(src).not.toContain("classifyStaffAssistantTurn");
      expect(src).not.toContain('from "../gate.js"');
    }
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("Hello.")],
    });
    const turn = await runStaffAssistantHostTurn({
      model,
      messages: [{ role: "user", content: "Hi" }],
      contracts: [listOrders],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
    });
    expect(turn.speech.source).toBe("model");
  });
});
