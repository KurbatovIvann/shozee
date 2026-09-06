/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ASSISTANT_SURFACE_REGISTRY,
  ASSISTANT_TOOL_CLIPPED_STATUS,
  ASSISTANT_TOOL_NON_RESULT_STATUSES,
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
  assistantSurfacesFromToolResults,
  hydratableAssistantActionNames,
  isAssistantSurfaceResultOutput,
  parseOrderEntitySurfaces,
  parseOrdersAggregateSurface,
  parseOrdersListSurface,
  staffAssistantPresentationEnvelopeSchema,
  staffAssistantPresentationEnvelopesFromToolResults,
  unrestorableAssistantActionNames,
  unwrapToolOutput,
  type AssistantOrdersAggregateData,
  type AssistantOrdersListData,
  type AssistantSurfaceData,
  type AssistantSurfaceDescriptor,
  type AssistantSurfaceToolResult,
} from "./assistant-surfaces/index.js";

const ORDER_A = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const ORDER_B = "1a2b3c4d-5e6f-4789-8abc-def012345678";

function result(
  toolName: string,
  output: unknown,
  toolCallId?: string,
): AssistantSurfaceToolResult {
  if (toolCallId === undefined) {
    return { toolName, output };
  }
  return { toolName, output, toolCallId };
}

function pageRow(
  orderId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    orderNumber: "1049",
    customer: { nameSnapshot: "Ivan", linkedCustomerId: null },
    status: "new",
    itemCount: 2,
    totalGrossMinor: "33000",
    currency: "UAH",
    createdAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

function pageOutput(
  items: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "page.summary",
    items,
    nextCursor: null,
    customerMatchTruncated: false,
    ...extra,
  };
}

function countsOutput(
  buckets: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "aggregate",
    orderCount: 6,
    grossByCurrency: [{ currency: "UAH", grossAmountMinor: "1000" }],
    buckets,
    statusBuckets: [],
    bucketsTruncated: false,
    customerMatchTruncated: false,
    ...extra,
  };
}

function listOf(
  surfaces: readonly AssistantSurfaceData[],
): AssistantOrdersListData | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-list") {
      return surface;
    }
  }
  return null;
}

function aggregateOf(
  surfaces: readonly AssistantSurfaceData[],
): AssistantOrdersAggregateData | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-aggregate") {
      return surface;
    }
  }
  return null;
}

describe("ASSISTANT_SURFACE_REGISTRY integrity", () => {
  it("has unique kinds, positive integer versions, and non-empty toolNames/promptLine", () => {
    const kinds = ASSISTANT_SURFACE_REGISTRY.map((entry) => entry.kind);
    expect(kinds).toEqual(["orders-list", "orders-aggregate", "order-entity"]);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const entry of ASSISTANT_SURFACE_REGISTRY) {
      expect(Number.isInteger(entry.version)).toBe(true);
      expect(entry.version).toBeGreaterThan(0);
      expect(entry.toolNames.length).toBeGreaterThan(0);
      expect(entry.promptLine.length).toBeGreaterThan(0);
      expect(entry.actionNames.length).toBeGreaterThan(0);
    }
  });
});

describe("isAssistantSurfaceResultOutput", () => {
  it("rejects error without requiring code", () => {
    expect(
      isAssistantSurfaceResultOutput({
        status: "error",
        message: "failed",
      }),
    ).toBe(false);
    expect(
      isAssistantSurfaceResultOutput({
        status: "error",
        code: "PERMISSION_DENIED",
        message: "Staff cannot list these orders",
      }),
    ).toBe(false);
  });

  it("rejects confirmation_required", () => {
    expect(
      isAssistantSurfaceResultOutput({ status: "confirmation_required" }),
    ).toBe(false);
  });

  it("rejects needs_choice", () => {
    expect(isAssistantSurfaceResultOutput({ status: "needs_choice" })).toBe(
      false,
    );
  });

  it("accepts clipped as a result that unwraps", () => {
    const clipped = {
      status: ASSISTANT_TOOL_CLIPPED_STATUS,
      preview: pageOutput([pageRow(ORDER_A)]),
      omitted: 12,
    };
    expect(isAssistantSurfaceResultOutput(clipped)).toBe(true);
    expect(unwrapToolOutput(clipped)).toEqual({
      payload: pageOutput([pageRow(ORDER_A)]),
      clipped: true,
    });
  });

  it("does not reject an unknown status", () => {
    expect(isAssistantSurfaceResultOutput({ status: "ok" })).toBe(true);
    expect(
      isAssistantSurfaceResultOutput({ status: 1, orderId: ORDER_A }),
    ).toBe(true);
  });

  it("rejects undefined and accepts a payload with no status", () => {
    expect(isAssistantSurfaceResultOutput(undefined)).toBe(false);
    expect(isAssistantSurfaceResultOutput({ orderId: ORDER_A })).toBe(true);
  });

  it("names the non-result set without clipped", () => {
    expect([...ASSISTANT_TOOL_NON_RESULT_STATUSES]).toEqual([
      "error",
      "confirmation_required",
      "needs_choice",
    ]);
    expect(ASSISTANT_TOOL_NON_RESULT_STATUSES).not.toContain(
      ASSISTANT_TOOL_CLIPPED_STATUS,
    );
  });
});

describe("parseOrdersListSurface", () => {
  it("extracts raw row fields without labels", () => {
    const data = parseOrdersListSurface([
      result(ORDERS_LIST_PAGE_TOOL, pageOutput([pageRow(ORDER_A)])),
    ]);
    expect(data?.kind).toBe("orders-list");
    expect(data?.rows).toEqual([
      {
        orderId: ORDER_A,
        orderNumber: "1049",
        customerNameSnapshot: "Ivan",
        status: "new",
        itemCount: 2,
        createdAt: "2026-09-03T10:00:00.000Z",
        total: { amountMinor: "33000", currency: "UAH" },
      },
    ]);
    expect(data?.clipped).toBe(false);
    expect(data?.hasMore).toBe(false);
  });

  it("caps rows at the named façade page cap", () => {
    const items = Array.from({ length: 55 }, (_, index) =>
      pageRow(
        `0f0e2d5c-4a1b-4c3d-9e8f-1029384756${String(index).padStart(2, "0")}`,
      ),
    );
    const data = parseOrdersListSurface([
      result(ORDERS_LIST_PAGE_TOOL, pageOutput(items)),
    ]);
    expect(ASSISTANT_ORDERS_LIST_ROW_MAX).toBe(50);
    expect(data?.rows).toHaveLength(50);
  });

  it("unwraps clipped page output", () => {
    const data = parseOrdersListSurface([
      result(ORDERS_LIST_PAGE_TOOL, {
        status: ASSISTANT_TOOL_CLIPPED_STATUS,
        omitted: 12,
        preview: pageOutput([pageRow(ORDER_A)]),
      }),
    ]);
    expect(data?.clipped).toBe(true);
    expect(data?.hasMore).toBe(true);
    expect(data?.rows).toHaveLength(1);
  });
});

describe("parseOrdersAggregateSurface", () => {
  it("extracts raw totals and status buckets", () => {
    const data = parseOrdersAggregateSurface([
      result(
        ORDERS_LIST_COUNTS_TOOL,
        countsOutput(
          [
            {
              identity: { kind: "status", status: "new" },
              orderCount: 2,
              grossByCurrency: [],
            },
          ],
          {
            statusBuckets: [
              {
                identity: { kind: "status", status: "new" },
                orderCount: 2,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "1000" },
                ],
              },
            ],
          },
        ),
      ),
    ]);
    expect(data?.kind).toBe("orders-aggregate");
    expect(data?.groupBy).toBe("status");
    expect(data?.orderCount).toBe(6);
    expect(data?.gross).toEqual([{ amountMinor: "1000", currency: "UAH" }]);
    expect(data?.statusBuckets).toEqual([
      {
        status: "new",
        orderCount: 2,
        gross: [{ amountMinor: "1000", currency: "UAH" }],
      },
    ]);
  });
});

describe("parseOrderEntitySurfaces", () => {
  it("extracts N entities from get/create without walking list rows", () => {
    const entities = parseOrderEntitySurfaces([
      result(ORDERS_LIST_PAGE_TOOL, pageOutput([pageRow(ORDER_A)])),
      result(
        "orders.get",
        {
          orderId: ORDER_A,
          orderNumber: "1049",
          status: "confirmed",
          totalGrossMinor: "33000",
          currency: "UAH",
        },
        "call-get",
      ),
      result(
        "orders.create",
        {
          orderId: ORDER_B,
          orderNumber: "1050",
          customer: { nameSnapshot: "Olya", linkedCustomerId: null },
          status: "new",
          totalGrossMinor: "1000",
          currency: "UAH",
        },
        "call-create",
      ),
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[0]?.orderId).toBe(ORDER_A);
    expect(entities[0]?.toolCallId).toBe("call-get");
    expect(entities[1]?.customerNameSnapshot).toBe("Olya");
  });

  it("omits needs_choice and error entity outputs", () => {
    expect(
      parseOrderEntitySurfaces([
        result("orders.create", { status: "needs_choice" }, "call-choice"),
        result("orders.get", { status: "error" }, "call-err"),
      ]),
    ).toEqual([]);
  });
});

describe("assistantSurfacesFromToolResults compose", () => {
  it("keeps list only when page and counts share a turn", () => {
    const surfaces = assistantSurfacesFromToolResults([
      result(
        ORDERS_LIST_COUNTS_TOOL,
        countsOutput([
          {
            identity: { kind: "status", status: "new" },
            orderCount: 2,
            grossByCurrency: [],
          },
        ]),
      ),
      result(ORDERS_LIST_PAGE_TOOL, pageOutput([pageRow(ORDER_A)])),
    ]);
    expect(listOf(surfaces)?.kind).toBe("orders-list");
    expect(aggregateOf(surfaces)).toBeNull();
    expect(
      surfaces.filter((surface) => surface.kind === "order-entity"),
    ).toEqual([]);
  });

  it("emits aggregate on counts-only turns", () => {
    const surfaces = assistantSurfacesFromToolResults([
      result(
        ORDERS_LIST_COUNTS_TOOL,
        countsOutput([
          {
            identity: { kind: "status", status: "new" },
            orderCount: 2,
            grossByCurrency: [],
          },
        ]),
      ),
    ]);
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)?.kind).toBe("orders-aggregate");
  });

  it("never emits both list and aggregate", () => {
    const withPage = assistantSurfacesFromToolResults([
      result(ORDERS_LIST_PAGE_TOOL, pageOutput([pageRow(ORDER_A)])),
      result(ORDERS_LIST_COUNTS_TOOL, countsOutput([])),
    ]);
    expect(listOf(withPage)).not.toBeNull();
    expect(aggregateOf(withPage)).toBeNull();
    const countsOnly = assistantSurfacesFromToolResults([
      result(ORDERS_LIST_COUNTS_TOOL, countsOutput([])),
    ]);
    expect(listOf(countsOnly)).toBeNull();
    expect(aggregateOf(countsOnly)).not.toBeNull();
  });

  it("emits N entity surfaces from get/create", () => {
    const surfaces = assistantSurfacesFromToolResults([
      result(
        "orders.get",
        { orderId: ORDER_A, orderNumber: "1049", status: "new" },
        "call-get",
      ),
      result(
        "orders.create",
        { orderId: ORDER_B, orderNumber: "1050", status: "confirmed" },
        "call-create",
      ),
    ]);
    expect(surfaces.map((surface) => surface.kind)).toEqual([
      "order-entity",
      "order-entity",
    ]);
  });
});

function fixtureDescriptor(args: {
  readonly kind: AssistantSurfaceDescriptor["kind"];
  readonly actionNames: readonly string[];
  readonly hydratable: boolean;
}): AssistantSurfaceDescriptor {
  return {
    kind: args.kind,
    version: 1,
    toolNames: [],
    actionNames: args.actionNames,
    hydratable: args.hydratable,
    promptLine: "fixture",
    parse: () => null,
  };
}

describe("hydration flags", () => {
  it("derives hydratable actions from the registry and does not restore lists", () => {
    expect([...hydratableAssistantActionNames()].sort()).toEqual([
      "orders.create",
      "orders.get",
    ]);
    expect([...unrestorableAssistantActionNames()]).toEqual(["orders.list"]);
    const list = ASSISTANT_SURFACE_REGISTRY.find(
      (entry) => entry.kind === "orders-list",
    );
    const aggregate = ASSISTANT_SURFACE_REGISTRY.find(
      (entry) => entry.kind === "orders-aggregate",
    );
    const entity = ASSISTANT_SURFACE_REGISTRY.find(
      (entry) => entry.kind === "order-entity",
    );
    expect(list?.hydratable).toBe(false);
    expect(aggregate?.hydratable).toBe(false);
    expect(entity?.hydratable).toBe(true);
  });

  it("recognises every unrestorable action name in a fixture registry (SHO-461)", () => {
    const fixtureRegistry: readonly AssistantSurfaceDescriptor[] = [
      fixtureDescriptor({
        kind: "orders-list",
        actionNames: ["orders.list"],
        hydratable: false,
      }),
      fixtureDescriptor({
        kind: "orders-aggregate",
        actionNames: ["customers.list"],
        hydratable: false,
      }),
      fixtureDescriptor({
        kind: "order-entity",
        actionNames: ["orders.get", "orders.create"],
        hydratable: true,
      }),
    ];
    expect(
      [...unrestorableAssistantActionNames(fixtureRegistry)].sort(),
    ).toEqual(["customers.list", "orders.list"]);
    expect([...hydratableAssistantActionNames(fixtureRegistry)].sort()).toEqual(
      ["orders.create", "orders.get"],
    );
  });
});

describe("staffAssistantPresentationEnvelope (SHO-458)", () => {
  it("names the same kinds compose would choose across list, aggregate, and entity", () => {
    const fixtures: readonly {
      readonly results: readonly AssistantSurfaceToolResult[];
      readonly kinds: readonly string[];
      readonly toolCallIds: readonly string[][];
    }[] = [
      {
        results: [
          result(
            "orders_list_page",
            pageOutput([pageRow(ORDER_A)]),
            "call-page",
          ),
          result(
            "orders_list_counts",
            countsOutput([
              {
                identity: { kind: "status", status: "new" },
                orderCount: 1,
              },
            ]),
            "call-counts",
          ),
        ],
        kinds: ["orders-list"],
        toolCallIds: [["call-page", "call-counts"]],
      },
      {
        results: [
          result(
            "orders_list_counts",
            countsOutput([
              {
                identity: { kind: "status", status: "confirmed" },
                orderCount: 4,
              },
            ]),
            "call-counts",
          ),
        ],
        kinds: ["orders-aggregate"],
        toolCallIds: [["call-counts"]],
      },
      {
        results: [
          result(
            "orders.get",
            { orderId: ORDER_A, orderNumber: "1049", status: "new" },
            "call-get",
          ),
        ],
        kinds: ["order-entity"],
        toolCallIds: [["call-get"]],
      },
    ];
    for (const fixture of fixtures) {
      const surfaces = assistantSurfacesFromToolResults(fixture.results);
      const envelopes = staffAssistantPresentationEnvelopesFromToolResults(
        fixture.results,
      );
      expect(surfaces.map((surface) => surface.kind)).toEqual(fixture.kinds);
      expect(envelopes.map((envelope) => envelope.surface)).toEqual(
        fixture.kinds,
      );
      expect(envelopes.map((envelope) => envelope.version)).toEqual(
        fixture.kinds.map(() => 1),
      );
      expect(envelopes.map((envelope) => envelope.toolCallIds)).toEqual(
        fixture.toolCallIds,
      );
    }
  });

  it("emits no envelope when the turn produced no surface", () => {
    expect(
      staffAssistantPresentationEnvelopesFromToolResults([
        result("orders_list_page", { status: "error", code: "INTERNAL" }),
      ]),
    ).toEqual([]);
    expect(staffAssistantPresentationEnvelopesFromToolResults([])).toEqual([]);
  });

  it("rejects malformed envelopes (missing surface, wrong types)", () => {
    expect(
      staffAssistantPresentationEnvelopeSchema.safeParse({
        version: 1,
        toolCallIds: ["call-page"],
      }).success,
    ).toBe(false);
    expect(
      staffAssistantPresentationEnvelopeSchema.safeParse({
        surface: "orders-list",
        version: "1",
        toolCallIds: ["call-page"],
      }).success,
    ).toBe(false);
    expect(
      staffAssistantPresentationEnvelopeSchema.safeParse({
        surface: "orders-list",
        version: 1,
        toolCallIds: "call-page",
      }).success,
    ).toBe(false);
    expect(
      staffAssistantPresentationEnvelopeSchema.safeParse({
        surface: "orders-list",
        version: 1,
        toolCallIds: [1],
      }).success,
    ).toBe(false);
  });

  it("parses an unknown kind so the client can fall back without crashing", () => {
    const parsed = staffAssistantPresentationEnvelopeSchema.safeParse({
      surface: "orders-table",
      version: 1,
      toolCallIds: ["call-page"],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("UNLINKED_CUSTOMER_NAME_SNAPSHOT", () => {
  it("is the protocol sentinel, not a localized label", () => {
    expect(UNLINKED_CUSTOMER_NAME_SNAPSHOT).toBe("unlinked");
  });
});
