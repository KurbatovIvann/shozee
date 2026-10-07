import {
  getGroupContract,
  listGroupsContract,
} from "@showzy/customers/contract";
import {
  ASSISTANT_CUSTOMER_GROUPS_ROW_MAX,
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
  assistantSurfacesFromToolResults,
  CUSTOMER_GROUP_ENTITY_GET_TOOL,
  CUSTOMER_GROUPS_LIST_TOOL,
  parseCustomerGroupEntitySurfaces,
  parseCustomerGroupsSurface,
  staffAssistantPresentationEnvelopesFromToolResults,
} from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import { toProviderToolName } from "./action-tool.js";
import {
  CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
  CUSTOMERS_LIST_GROUPS_TOOL_NAME,
  mapCustomersListGroupsOutput,
} from "./tool-facades/customers-list-groups.js";

const GROUP_A = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203";
const GROUP_B = "8b9c0d1e-2f30-4b4c-9d5e-6f7081920314";

function groupId(index: number): string {
  return `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(index).padStart(2, "0")}`;
}

function groupRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "Оптовики",
    slug: "optovyky",
    description: null,
    priceListId: null,
    memberCount: 4,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

function groupsToolOutput(
  items: readonly Record<string, unknown>[],
  nextCursor: string | null = null,
): unknown {
  return mapCustomersListGroupsOutput(
    listGroupsContract.output.parse({ items, nextCursor }),
  );
}

function groupOutput(overrides: Record<string, unknown> = {}): unknown {
  return getGroupContract.output.parse(groupRow(GROUP_A, overrides));
}

describe("the group surface tool names are the assistant's own (SHO-873)", () => {
  it("binds the façaded list and the unfaçaded get", () => {
    expect(CUSTOMER_GROUPS_LIST_TOOL).toBe(CUSTOMERS_LIST_GROUPS_TOOL_NAME);
    expect(CUSTOMER_GROUP_ENTITY_GET_TOOL).toBe(
      toProviderToolName("customers.getGroup"),
    );
  });
});

describe("customer-groups surface over the real customers.listGroups output (SHO-873)", () => {
  it("composes rows, counts and destination from a contract-parsed page", () => {
    const surface = parseCustomerGroupsSurface([
      {
        toolName: CUSTOMER_GROUPS_LIST_TOOL,
        output: groupsToolOutput([
          groupRow(GROUP_A),
          groupRow(GROUP_B, { name: "Кафе", memberCount: 0 }),
        ]),
      },
    ]);
    expect(surface?.kind).toBe("customer-groups");
    expect(surface?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
    });
    expect(surface?.rows).toEqual([
      { groupId: GROUP_A, name: "Оптовики", memberCount: 4 },
      { groupId: GROUP_B, name: "Кафе", memberCount: 0 },
    ]);
    expect(surface?.collection.truncated).toBe(false);
    expect(surface?.hasMore).toBe(false);
  });

  it("reads an absent member count as unknown rather than as none", () => {
    const surface = parseCustomerGroupsSurface([
      {
        toolName: CUSTOMER_GROUPS_LIST_TOOL,
        output: { items: [{ id: GROUP_A, name: "Кафе" }], nextCursor: null },
      },
    ]);
    expect(surface?.rows).toEqual([
      { groupId: GROUP_A, name: "Кафе", memberCount: null },
    ]);
  });

  it("caps the card below the façade page so a full page is visibly truncated", () => {
    const items = Array.from(
      { length: ASSISTANT_CUSTOMER_GROUPS_ROW_MAX + 2 },
      (_, index) => groupRow(groupId(index)),
    );
    const surface = parseCustomerGroupsSurface([
      { toolName: CUSTOMER_GROUPS_LIST_TOOL, output: groupsToolOutput(items) },
    ]);
    expect(ASSISTANT_CUSTOMER_GROUPS_ROW_MAX).toBeLessThanOrEqual(
      CUSTOMERS_LIST_GROUPS_ASSISTANT_LIMIT,
    );
    expect(surface?.rows).toHaveLength(ASSISTANT_CUSTOMER_GROUPS_ROW_MAX);
    expect(surface?.collection.rowCap).toBe(ASSISTANT_CUSTOMER_GROUPS_ROW_MAX);
    expect(surface?.collection.truncated).toBe(true);
    expect(surface?.hasMore).toBe(true);
  });

  it("carries a next cursor as more to come", () => {
    const surface = parseCustomerGroupsSurface([
      {
        toolName: CUSTOMER_GROUPS_LIST_TOOL,
        output: groupsToolOutput([groupRow(GROUP_A)], "next-page"),
      },
    ]);
    expect(surface?.nextCursor).toBe("next-page");
    expect(surface?.hasMore).toBe(true);
  });
});

describe("customer-group-entity surface over the real customers.getGroup output (SHO-873)", () => {
  it("composes the name, description and client count from a contract-parsed result", () => {
    expect(
      parseCustomerGroupEntitySurfaces([
        {
          toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL,
          output: groupOutput({ description: "Гуртові замовлення" }),
          toolCallId: "call-group",
        },
      ]),
    ).toEqual([
      {
        kind: "customer-group-entity",
        groupId: GROUP_A,
        name: "Оптовики",
        description: "Гуртові замовлення",
        memberCount: 4,
        toolCallId: "call-group",
      },
    ]);
  });

  it("reads a null description and an absent count as nothing to show", () => {
    expect(
      parseCustomerGroupEntitySurfaces([
        {
          toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL,
          output: { id: GROUP_A, name: "Кафе", description: null },
        },
      ]),
    ).toEqual([
      {
        kind: "customer-group-entity",
        groupId: GROUP_A,
        name: "Кафе",
        description: null,
        memberCount: null,
      },
    ]);
  });

  it("composes nothing from a not-found error envelope", () => {
    expect(
      parseCustomerGroupEntitySurfaces([
        {
          toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL,
          output: { status: "error", code: "NOT_FOUND", message: "no" },
        },
      ]),
    ).toEqual([]);
  });

  it("keeps one card per group read and one for the list in the same turn", () => {
    const results = [
      {
        toolName: CUSTOMER_GROUPS_LIST_TOOL,
        output: groupsToolOutput([groupRow(GROUP_A)]),
        toolCallId: "call-list",
      },
      {
        toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL,
        output: groupOutput(),
        toolCallId: "call-a",
      },
      {
        toolName: CUSTOMER_GROUP_ENTITY_GET_TOOL,
        output: getGroupContract.output.parse(
          groupRow(GROUP_B, { name: "Кафе", slug: "kafe" }),
        ),
        toolCallId: "call-b",
      },
    ];
    expect(
      assistantSurfacesFromToolResults(results).map((surface) => surface.kind),
    ).toEqual([
      "customer-groups",
      "customer-group-entity",
      "customer-group-entity",
    ]);
    expect(staffAssistantPresentationEnvelopesFromToolResults(results)).toEqual(
      [
        {
          surface: "customer-group-entity",
          version: 1,
          toolCallIds: ["call-a", "call-b"],
        },
        { surface: "customer-groups", version: 1, toolCallIds: ["call-list"] },
      ],
    );
  });
});
