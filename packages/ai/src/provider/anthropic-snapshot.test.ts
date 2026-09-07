import { readFileSync } from "node:fs";

import { defineActionContract } from "@showzy/core/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  staffAssistantTools,
  STAFF_ASSISTANT_TOOL_SEARCH_NAME,
} from "../action-tool.js";
import { createAnthropicStaffProviderAdapter } from "./anthropic.js";
import { snapshotStaffProviderSurface } from "./snapshot.js";

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

describe("Anthropic adapter snapshot (SHO-508)", () => {
  it("matches the pre-refactor providerOptions and operational tool set", () => {
    const provider = createAnthropicStaffProviderAdapter();
    const tools = staffAssistantTools(
      [listOrders, deleteCustomer],
      () => Promise.resolve({}),
      provider,
    );
    expect(Object.keys(tools)[0]).toBe(STAFF_ASSISTANT_TOOL_SEARCH_NAME);
    const snapshot = snapshotStaffProviderSurface({
      system: provider.systemProviderOptions(),
      history: provider.historyBreakpointOptions(),
      reply: provider.replyProviderOptions(),
      tools,
    });
    const expected = readFileSync(
      new URL("./anthropic.snapshot.json", import.meta.url),
      "utf8",
    );
    expect(snapshot).toBe(expected);
    expect(snapshot).toContain('"ttl": "1h"');
    expect(snapshot).toContain('"ttl": "5m"');
    expect(snapshot).toContain("tool_search_bm25_20251119");
  });
});
