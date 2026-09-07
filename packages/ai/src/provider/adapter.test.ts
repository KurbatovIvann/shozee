import { defineActionContract } from "@showzy/core/contract";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "../action-tool.js";
import { StaffAssistantNotConfiguredError } from "../errors.js";
import { streamStaffAssistantChat } from "../staff-assistant-stream.js";
import {
  MockLanguageModelV3,
  mockTextStream,
  readUiMessageSsePayloads,
} from "../test.js";
import { STAFF_ASSISTANT_EMPTY_TOOLSET_HASH } from "../toolset-hash.js";
import type { StaffProviderAdapter } from "./types.js";

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

function fakeStaffProvider(): StaffProviderAdapter {
  return {
    id: "fake",
    createModel(): LanguageModel {
      throw new StaffAssistantNotConfiguredError();
    },
    decorateToolSet(tools) {
      return tools;
    },
    systemProviderOptions() {
      return {};
    },
    historyBreakpointOptions() {
      return {};
    },
    toolInputSchema(schema) {
      return { ...z.toJSONSchema(schema) };
    },
    replyProviderOptions() {
      return {};
    },
    pricing() {
      return null;
    },
  };
}

function toolHasDeferLoading(tool: {
  readonly providerOptions?: unknown;
}): boolean {
  return JSON.stringify(tool.providerOptions ?? {}).includes("deferLoading");
}

describe("fake StaffProviderAdapter (SHO-508)", () => {
  it("attaches every action and never adds search or deferLoading", () => {
    const provider = fakeStaffProvider();
    const tools = staffAssistantTools(
      [listOrders, deleteCustomer],
      () => Promise.resolve({}),
      provider,
    );
    expect(Object.keys(tools)).toEqual([
      ORDERS_LIST_PAGE_TOOL_NAME,
      ORDERS_LIST_COUNTS_TOOL_NAME,
      "customers_deleteCustomer",
    ]);
    expect(tools[STAFF_ASSISTANT_TOOL_SEARCH_NAME]).toBeUndefined();
    for (const tool of Object.values(tools)) {
      if (tool === undefined) {
        continue;
      }
      expect(toolHasDeferLoading(tool)).toBe(false);
    }
  });

  it("still runs streamStaffAssistantChat against MockLanguageModelV3", async () => {
    const provider = fakeStaffProvider();
    const model = new MockLanguageModelV3({
      doStream: [mockTextStream("ok")],
    });
    const { response, completion } = streamStaffAssistantChat({
      model,
      messages: [{ role: "user", content: "Hello" }],
      contracts: [listOrders, deleteCustomer],
      execute: () => Promise.resolve({ items: [], nextCursor: null }),
      provider,
    });
    const payloads = await readUiMessageSsePayloads(response);
    const turn = await completion;
    expect(turn.text).toBe("ok");
    expect(JSON.stringify(payloads)).toContain("ok");
    expect(turn.toolsAttached).toBe(true);
    expect(turn.toolsetHash).not.toBe(STAFF_ASSISTANT_EMPTY_TOOLSET_HASH);
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    for (const call of model.doStreamCalls) {
      expect(call.providerOptions?.["anthropic"]).toBeUndefined();
    }
  });
});
