import { staffAssistantPresentationEnvelopesFromToolResults } from "@showzy/validation/assistant-surfaces";
import { describe, expect, it } from "vitest";

import type { AssistantChatPart } from "./confirmation-presenter";
import { assistantSurfacesFromParts } from "../surfaces";
import { assistantSurfaceToolResultsFromParts } from "../surfaces/helpers";

const ORDER_A = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";

function pageRow(
  orderId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    orderId,
    orderNumber: "1049",
    customer: { nameSnapshot: "Іван", linkedCustomerId: null },
    status: "new",
    itemCount: 2,
    totalGrossMinor: "33000",
    currency: "UAH",
    createdAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  };
}

const listParts: AssistantChatPart[] = [
  {
    type: "tool-orders_list_counts",
    toolCallId: "call-counts",
    state: "output-available",
    output: {
      kind: "aggregate",
      buckets: [{ identity: { kind: "status", status: "new" }, orderCount: 1 }],
    },
  },
  {
    type: "tool-orders_list_page",
    toolCallId: "call-page",
    state: "output-available",
    output: {
      kind: "page.summary",
      items: [pageRow(ORDER_A)],
      nextCursor: null,
      customerMatchTruncated: false,
    },
  },
];

const aggregateParts: AssistantChatPart[] = [
  {
    type: "tool-orders_list_counts",
    toolCallId: "call-counts",
    state: "output-available",
    output: {
      kind: "aggregate",
      orderCount: 6,
      grossByCurrency: [{ currency: "UAH", grossAmountMinor: "1000" }],
      buckets: [
        {
          identity: { kind: "status", status: "confirmed" },
          orderCount: 4,
        },
      ],
    },
  },
];

const entityParts: AssistantChatPart[] = [
  {
    type: "tool-orders_get",
    toolCallId: "call-get",
    state: "output-available",
    output: {
      orderId: ORDER_A,
      orderNumber: "1049",
      status: "new",
      totalGrossMinor: "33000",
      currency: "UAH",
    },
  },
];

const fixtures: readonly {
  readonly name: string;
  readonly parts: readonly AssistantChatPart[];
  readonly envelope: {
    readonly surface: string;
    readonly version: number;
    readonly toolCallIds: readonly string[];
  };
}[] = [
  {
    name: "orders-list",
    parts: listParts,
    envelope: {
      surface: "orders-list",
      version: 1,
      toolCallIds: ["call-page", "call-counts"],
    },
  },
  {
    name: "orders-aggregate",
    parts: aggregateParts,
    envelope: {
      surface: "orders-aggregate",
      version: 1,
      toolCallIds: ["call-counts"],
    },
  },
  {
    name: "order-entity",
    parts: entityParts,
    envelope: {
      surface: "order-entity",
      version: 1,
      toolCallIds: ["call-get"],
    },
  },
];

function withEnvelope(
  parts: readonly AssistantChatPart[],
  data: unknown,
): AssistantChatPart[] {
  return [...parts, { type: "data-presentation", data }];
}

describe("data-presentation envelope (SHO-458)", () => {
  it("server-chosen kind equals client-rendered kind for all three surfaces", () => {
    for (const fixture of fixtures) {
      const composed = assistantSurfacesFromParts(fixture.parts, "uk");
      const envelopes = staffAssistantPresentationEnvelopesFromToolResults(
        assistantSurfaceToolResultsFromParts(fixture.parts),
      );
      expect(envelopes, fixture.name).toEqual([fixture.envelope]);
      const named = assistantSurfacesFromParts(
        withEnvelope(fixture.parts, envelopes[0]),
        "uk",
      );
      expect(
        composed.map((surface) => surface.kind),
        fixture.name,
      ).toEqual([fixture.envelope.surface]);
      expect(
        named.map((surface) => surface.kind),
        fixture.name,
      ).toEqual([fixture.envelope.surface]);
      expect(named, fixture.name).toEqual(composed);
    }
  });

  it("renders the envelope kind when it disagrees with compose", () => {
    expect(
      assistantSurfacesFromParts(listParts, "uk").map(
        (surface) => surface.kind,
      ),
    ).toEqual(["orders-list"]);

    const envelopes = staffAssistantPresentationEnvelopesFromToolResults(
      assistantSurfaceToolResultsFromParts(aggregateParts),
    );
    expect(envelopes).toEqual([
      {
        surface: "orders-aggregate",
        version: 1,
        toolCallIds: ["call-counts"],
      },
    ]);

    const named = assistantSurfacesFromParts(
      withEnvelope(listParts, envelopes[0]),
      "uk",
    );
    expect(named.map((surface) => surface.kind)).toEqual(["orders-aggregate"]);
  });

  it("envelope absent renders identically to the shared compose path", () => {
    for (const fixture of fixtures) {
      const without = assistantSurfacesFromParts(fixture.parts, "uk");
      expect(without.map((surface) => surface.kind)).toEqual([
        fixture.envelope.surface,
      ]);
      expect(without.length).toBeGreaterThan(0);
    }
  });

  it("unknown kind falls back to compose without crashing", () => {
    const parts = withEnvelope(listParts, {
      surface: "orders-table",
      version: 1,
      toolCallIds: ["call-page"],
    });
    expect(() => assistantSurfacesFromParts(parts, "uk")).not.toThrow();
    expect(assistantSurfacesFromParts(parts, "uk")).toEqual(
      assistantSurfacesFromParts(listParts, "uk"),
    );
  });

  it("unknown version falls back to compose without crashing", () => {
    const parts = withEnvelope(listParts, {
      surface: "orders-list",
      version: 99,
      toolCallIds: ["call-page", "call-counts"],
    });
    expect(() => assistantSurfacesFromParts(parts, "uk")).not.toThrow();
    expect(assistantSurfacesFromParts(parts, "uk")).toEqual(
      assistantSurfacesFromParts(listParts, "uk"),
    );
  });

  it("malformed envelopes are ignored and fall back without crashing", () => {
    const malformed: unknown[] = [
      { version: 1, toolCallIds: ["call-page"] },
      { surface: "orders-list", version: "1", toolCallIds: ["call-page"] },
      { surface: "orders-list", version: 1, toolCallIds: "call-page" },
      { surface: "orders-list", version: 1, toolCallIds: [1] },
      null,
      "nope",
    ];
    for (const data of malformed) {
      const parts = withEnvelope(listParts, data);
      expect(() => assistantSurfacesFromParts(parts, "uk")).not.toThrow();
      expect(assistantSurfacesFromParts(parts, "uk")).toEqual(
        assistantSurfacesFromParts(listParts, "uk"),
      );
    }
  });

  it("binds a surface when the tool-call id is longer than the server clip cap", () => {
    const longToolCallId = `call-${"x".repeat(128)}`;
    expect(longToolCallId.length).toBeGreaterThan(128);
    const parts: AssistantChatPart[] = [
      {
        type: "tool-orders_get",
        toolCallId: longToolCallId,
        state: "output-available",
        output: {
          orderId: ORDER_A,
          orderNumber: "1049",
          status: "new",
          totalGrossMinor: "33000",
          currency: "UAH",
        },
      },
    ];
    const envelope = {
      surface: "order-entity",
      version: 1,
      toolCallIds: [longToolCallId],
    };
    const named = assistantSurfacesFromParts(
      withEnvelope(parts, envelope),
      "uk",
    );
    const composed = assistantSurfacesFromParts(parts, "uk");
    expect(named.map((surface) => surface.kind)).toEqual(["order-entity"]);
    expect(named).toEqual(composed);
  });

  it("does not render a partial card for an unknown kind when tools would compose a list", () => {
    const parts = withEnvelope(listParts, {
      surface: "orders-table",
      version: 1,
      toolCallIds: ["call-page"],
    });
    const surfaces = assistantSurfacesFromParts(parts, "uk");
    expect(surfaces.map((surface) => surface.kind)).toEqual(["orders-list"]);
  });
});
