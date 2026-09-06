import { defineActionContract } from "@showzy/core/contract";
import {
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_PHONE_MAX,
} from "@showzy/validation/customers";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIPPED_STATUS,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "../clip-tool-result.js";
import {
  CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
  CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
  CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX,
  CUSTOMERS_LIST_CUSTOMERS_SEARCH_MAX,
  CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME,
  customersListCustomersFacadeTools,
  customersListCustomersInputSchema,
  mapCustomersListCustomersInput,
  mapCustomersListCustomersOutput,
} from "./customers-list-customers.js";

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

const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const groupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const priceListId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function fatCustomerRow(
  index: number,
  name = `Customer ${String(index)}`,
): {
  id: string;
  name: string;
  phone: string;
  email: string;
  userId: string;
  notes: string;
  groupId: string;
  priceListId: string;
  status: "active";
  linkedCounterpartyCount: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
    name,
    phone: "+380501234567",
    email: `c${String(index)}@example.com`,
    userId: "user_secret_id",
    notes: "n".repeat(200),
    groupId,
    priceListId,
    status: "active",
    linkedCounterpartyCount: 3,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  };
}

function compactCustomerRow(
  index: number,
  name = `Customer ${String(index)}`,
): {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: "active";
  groupId: string;
  priceListId: string;
} {
  const row = fatCustomerRow(index, name);
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    groupId: row.groupId,
    priceListId: row.priceListId,
  };
}

function maxLengthCompactRow(index: number): {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: "archived";
  groupId: string;
  priceListId: string;
} {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
    name: "n".repeat(CUSTOMER_NAME_MAX),
    phone: "p".repeat(CUSTOMER_PHONE_MAX),
    email: "e".repeat(CUSTOMER_EMAIL_MAX),
    status: "archived",
    groupId,
    priceListId,
  };
}

describe("mapCustomersListCustomersInput", () => {
  it("defaults status to active and limit to the named assistant cap", () => {
    const parsed = customersListCustomersInputSchema.parse({});
    expect(mapCustomersListCustomersInput(parsed)).toEqual({
      status: "active",
      limit: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
    });
  });

  it("maps status, trimmed search, groupId, limit, and cursor onto canonical input", () => {
    const parsed = customersListCustomersInputSchema.parse({
      status: "all",
      search: "  Катя  ",
      groupId,
      limit: 3,
      cursor: "c".repeat(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX),
    });
    expect(mapCustomersListCustomersInput(parsed)).toEqual({
      status: "all",
      search: "Катя",
      groupId,
      limit: 3,
      cursor: "c".repeat(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX),
    });
  });
});

describe("mapCustomersListCustomersOutput", () => {
  it("keeps phone, email, groupId, and priceListId and drops notes, userId, timestamps, and counterparty count", () => {
    const mapped = mapCustomersListCustomersOutput({
      items: [fatCustomerRow(1, "Катя")],
      nextCursor: "cursor-1",
    });
    expect(mapped).toEqual({
      items: [compactCustomerRow(1, "Катя")],
      nextCursor: "cursor-1",
    });
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("notes");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("user_secret_id");
    expect(serialized).not.toContain("linkedCounterpartyCount");
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain("updatedAt");
    expect(serialized).toContain("+380501234567");
    expect(serialized).toContain("c1@example.com");
    expect(serialized).toContain(groupId);
    expect(serialized).toContain(priceListId);
  });

  it("passes typed errors through unchanged", () => {
    const error = {
      status: "error",
      code: "NOT_FOUND",
      message: "Customer not found.",
    };
    expect(mapCustomersListCustomersOutput(error)).toBe(error);
  });
});

describe("customersListCustomersFacadeTools", () => {
  it("executes customers.listCustomers with mapped canonical input and toolCallId", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [fatCustomerRow(1, "Катя")],
        nextCursor: null,
      }),
    );
    const tools = customersListCustomersFacadeTools(listCustomers, execute);
    const executeTool = tools[CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { search: "Катя", status: "active", limit: 7 },
      { toolCallId: "call-customers", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_LIST_CUSTOMERS_ACTION_NAME,
      {
        status: "active",
        search: "Катя",
        limit: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-customers" },
    );
    expect(result).toEqual({
      items: [compactCustomerRow(1, "Катя")],
      nextCursor: null,
    });
  });

  it("exposes object JSON Schema type without the Anthropic union patch", async () => {
    const tools = customersListCustomersFacadeTools(listCustomers, () =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const json = await asSchema(
      tools[CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]?.inputSchema,
    ).jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
    expect(json["properties"]).toHaveProperty("search");
    expect(json["properties"]).not.toHaveProperty("query");
  });

  it("duplicates list caps and rejects overlong search, cursor, or limit above the named cap", () => {
    expect(CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT).toBe(7);
    expect(CUSTOMERS_LIST_CUSTOMERS_SEARCH_MAX).toBe(100);
    expect(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX).toBe(80);
    expect(
      customersListCustomersInputSchema.safeParse({
        search: "q".repeat(CUSTOMERS_LIST_CUSTOMERS_SEARCH_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      customersListCustomersInputSchema.safeParse({
        cursor: "c".repeat(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      customersListCustomersInputSchema.safeParse({
        limit: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      customersListCustomersInputSchema.safeParse({
        limit: 20,
      }).success,
    ).toBe(false);
    expect(
      customersListCustomersInputSchema.safeParse({
        groupId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });
});

describe("compact customers.listCustomers clip envelope", () => {
  it("does not clip an assistant-limit max-length compact page plus a max cursor", () => {
    const items = Array.from(
      { length: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT },
      (_, index) => maxLengthCompactRow(index),
    );
    const nextCursor = "c".repeat(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX);
    const mapped = mapCustomersListCustomersOutput({
      items,
      nextCursor,
    });
    expect(JSON.stringify(mapped).length).toBeLessThanOrEqual(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
    expect(JSON.stringify(mapped).length).toBe(3957);
    const clipped = clipStaffAssistantToolResult(mapped);
    expect(clipped).toBe(mapped);
    expect(
      typeof clipped === "object" &&
        clipped !== null &&
        "items" in clipped &&
        Array.isArray(clipped.items),
    ).toBe(true);
    if (
      typeof clipped !== "object" ||
      clipped === null ||
      !("items" in clipped) ||
      !Array.isArray(clipped.items)
    ) {
      return;
    }
    expect(clipped.items).toHaveLength(
      CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT,
    );
    expect("nextCursor" in clipped && clipped.nextCursor).toBe(nextCursor);
    expect(clipped.items[0]).toEqual(items[0]);
    const serialized = JSON.stringify(clipped);
    expect(serialized).toContain("p".repeat(CUSTOMER_PHONE_MAX));
    expect(serialized).toContain("e".repeat(CUSTOMER_EMAIL_MAX));
    expect(serialized).toContain(groupId);
    expect(serialized).toContain(priceListId);
  });

  it("one extra max-length row plus a max cursor still fits the raised clip budget", () => {
    const items = Array.from(
      { length: CUSTOMERS_LIST_CUSTOMERS_ASSISTANT_LIMIT + 1 },
      (_, index) => maxLengthCompactRow(index),
    );
    const page = {
      items,
      nextCursor: "c".repeat(CUSTOMERS_LIST_CUSTOMERS_CURSOR_MAX),
    };
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
  });

  it("keeps phone and email on a 20-row compact page after clip identity shrink", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...compactCustomerRow(index, `N${"x".repeat(118)}`),
      notes: "n".repeat(1_000),
    }));
    const page = { items, nextCursor: null };
    expect(JSON.stringify(page).length).toBeGreaterThan(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
    const clipped = clipStaffAssistantToolResult(page);
    expect(clipped).not.toBe(page);
    const serialized = JSON.stringify(clipped);
    expect(serialized).toContain(items[0]?.phone);
    expect(serialized).toContain(items[0]?.email);
    expect(serialized).toContain(groupId);
    expect(serialized).toContain(priceListId);
    expect(serialized).toContain(items[0]?.id);
    expect(
      typeof clipped === "object" &&
        clipped !== null &&
        "status" in clipped &&
        clipped.status === STAFF_ASSISTANT_CLIPPED_STATUS,
    ).toBe(true);
  });
});

describe("fat vs compact customer rows", () => {
  it("omits notes from the mapped page that includes customerId-shaped rows", () => {
    const mapped = mapCustomersListCustomersOutput({
      items: [
        {
          ...fatCustomerRow(0, "Катя"),
          id: customerId,
        },
      ],
      nextCursor: null,
    });
    expect(mapped).toEqual({
      items: [
        {
          ...compactCustomerRow(0, "Катя"),
          id: customerId,
        },
      ],
      nextCursor: null,
    });
  });
});
