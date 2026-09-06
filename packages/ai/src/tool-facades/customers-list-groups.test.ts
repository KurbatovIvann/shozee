import { defineActionContract } from "@showzy/core/contract";
import { GROUP_NAME_MAX } from "@showzy/validation/customers";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  clipStaffAssistantToolResult,
  STAFF_ASSISTANT_CLIP_JSON_MAX,
} from "../clip-tool-result.js";
import {
  CUSTOMERS_LIST_GROUPS_ACTION_NAME,
  CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
  CUSTOMERS_LIST_GROUPS_CURSOR_MAX,
  CUSTOMERS_LIST_GROUPS_SEARCH_MAX,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  customersListGroupsFacadeTools,
  customersListGroupsInputSchema,
  mapCustomersListGroupsInput,
  mapCustomersListGroupsOutput,
} from "./customers-list-groups.js";

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

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const priceListId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function fatGroupRow(
  index: number,
  name = `Group ${String(index)}`,
): {
  id: string;
  name: string;
  slug: string;
  description: string;
  priceListId: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
    name,
    slug: `group-${String(index)}`,
    description: "d".repeat(2000),
    priceListId,
    memberCount: 12,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  };
}

function compactGroupRow(
  index: number,
  name = `Group ${String(index)}`,
): {
  id: string;
  name: string;
  memberCount: number;
  priceListId: string;
} {
  const row = fatGroupRow(index, name);
  return {
    id: row.id,
    name: row.name,
    memberCount: row.memberCount,
    priceListId: row.priceListId,
  };
}

function maxLengthCompactRow(index: number): {
  id: string;
  name: string;
  memberCount: number;
  priceListId: string;
} {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString().padStart(12, "0")}`,
    name: "n".repeat(GROUP_NAME_MAX),
    memberCount: 999_999_999,
    priceListId,
  };
}

describe("mapCustomersListGroupsInput", () => {
  it("defaults limit to the named assistant cap", () => {
    const parsed = customersListGroupsInputSchema.parse({});
    expect(mapCustomersListGroupsInput(parsed)).toEqual({
      limit: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
    });
  });

  it("maps trimmed search, limit, and cursor onto canonical input", () => {
    const parsed = customersListGroupsInputSchema.parse({
      search: "  VIP  ",
      limit: 3,
      cursor: "c".repeat(CUSTOMERS_LIST_GROUPS_CURSOR_MAX),
    });
    expect(mapCustomersListGroupsInput(parsed)).toEqual({
      search: "VIP",
      limit: 3,
      cursor: "c".repeat(CUSTOMERS_LIST_GROUPS_CURSOR_MAX),
    });
  });
});

describe("mapCustomersListGroupsOutput", () => {
  it("keeps memberCount and priceListId and drops description, slug, and timestamps", () => {
    const mapped = mapCustomersListGroupsOutput({
      items: [fatGroupRow(1, "VIP")],
      nextCursor: "cursor-1",
    });
    expect(mapped).toEqual({
      items: [compactGroupRow(1, "VIP")],
      nextCursor: "cursor-1",
    });
    const serialized = JSON.stringify(mapped);
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("slug");
    expect(serialized).not.toContain("d".repeat(2000));
    expect(serialized).not.toContain("createdAt");
    expect(serialized).not.toContain("updatedAt");
    expect(serialized).toContain("VIP");
    expect(serialized).toContain('"memberCount":12');
    expect(serialized).toContain(priceListId);
  });

  it("passes typed errors through unchanged", () => {
    const error = {
      status: "error",
      code: "NOT_FOUND",
      message: "Group not found.",
    };
    expect(mapCustomersListGroupsOutput(error)).toBe(error);
  });
});

describe("customersListGroupsFacadeTools", () => {
  it("executes customers.listGroups with mapped canonical input and toolCallId", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        items: [fatGroupRow(1, "VIP")],
        nextCursor: null,
      }),
    );
    const tools = customersListGroupsFacadeTools(listGroups, execute);
    const executeTool = tools[CUSTOMERS_LIST_GROUPS_TOOL_NAME]?.execute;
    expect(executeTool).toBeTypeOf("function");
    if (executeTool === undefined) {
      return;
    }
    const result: unknown = await executeTool(
      { search: "VIP", limit: 14 },
      { toolCallId: "call-groups", messages: [], context: undefined },
    );
    expect(execute).toHaveBeenCalledWith(
      CUSTOMERS_LIST_GROUPS_ACTION_NAME,
      {
        search: "VIP",
        limit: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
      },
      { toolCallId: "call-groups" },
    );
    expect(result).toEqual({
      items: [compactGroupRow(1, "VIP")],
      nextCursor: null,
    });
  });

  it("exposes object JSON Schema type without the Anthropic union patch", async () => {
    const tools = customersListGroupsFacadeTools(listGroups, () =>
      Promise.resolve({ items: [], nextCursor: null }),
    );
    const json = await asSchema(
      tools[CUSTOMERS_LIST_GROUPS_TOOL_NAME]?.inputSchema,
    ).jsonSchema;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
    expect(json["properties"]).toHaveProperty("search");
    expect(json["properties"]).not.toHaveProperty("query");
    expect(json["properties"]).not.toHaveProperty("status");
  });

  it("duplicates list caps and rejects overlong search, cursor, or limit above the named cap", () => {
    expect(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT).toBe(14);
    expect(CUSTOMERS_LIST_GROUPS_SEARCH_MAX).toBe(100);
    expect(CUSTOMERS_LIST_GROUPS_CURSOR_MAX).toBe(200);
    expect(
      customersListGroupsInputSchema.safeParse({
        search: "q".repeat(CUSTOMERS_LIST_GROUPS_SEARCH_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      customersListGroupsInputSchema.safeParse({
        cursor: "c".repeat(CUSTOMERS_LIST_GROUPS_CURSOR_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      customersListGroupsInputSchema.safeParse({
        limit: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT + 1,
      }).success,
    ).toBe(false);
    expect(
      customersListGroupsInputSchema.safeParse({
        limit: 20,
      }).success,
    ).toBe(false);
    expect(
      customersListGroupsInputSchema.safeParse({
        status: "active",
      }).success,
    ).toBe(false);
  });
});

describe("compact customers.listGroups clip envelope", () => {
  it("does not clip an assistant-limit max-length compact page plus a max cursor", () => {
    const items = Array.from(
      { length: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT },
      (_, index) => maxLengthCompactRow(index),
    );
    const nextCursor = "c".repeat(CUSTOMERS_LIST_GROUPS_CURSOR_MAX);
    const mapped = mapCustomersListGroupsOutput({
      items,
      nextCursor,
    });
    expect(JSON.stringify(mapped).length).toBeLessThanOrEqual(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
    expect(JSON.stringify(mapped).length).toBe(3769);
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
    expect(clipped.items).toHaveLength(CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT);
    expect("nextCursor" in clipped && clipped.nextCursor).toBe(nextCursor);
    expect(clipped.items[0]).toEqual(items[0]);
    const serialized = JSON.stringify(clipped);
    expect(serialized).toContain('"memberCount":999999999');
    expect(serialized).toContain(priceListId);
    expect(serialized).not.toContain("description");
    expect(serialized).not.toContain("slug");
  });

  it("one extra max-length row plus a max cursor still fits the raised clip budget", () => {
    const items = Array.from(
      { length: CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT + 1 },
      (_, index) => maxLengthCompactRow(index),
    );
    const page = {
      items,
      nextCursor: "c".repeat(CUSTOMERS_LIST_GROUPS_CURSOR_MAX),
    };
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(
      STAFF_ASSISTANT_CLIP_JSON_MAX,
    );
  });
});

describe("fat vs compact group rows", () => {
  it("omits description from the mapped page that includes groupId-shaped rows", () => {
    const mapped = mapCustomersListGroupsOutput({
      items: [
        {
          ...fatGroupRow(0, "VIP"),
          id: groupId,
        },
      ],
      nextCursor: null,
    });
    expect(mapped).toEqual({
      items: [
        {
          ...compactGroupRow(0, "VIP"),
          id: groupId,
        },
      ],
      nextCursor: null,
    });
  });
});
