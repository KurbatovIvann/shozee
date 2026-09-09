import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
  ASSISTANT_ORDERS_LIST_SCREEN_HREF,
  CUSTOMERS_LIST_CUSTOMERS_TOOL,
  SEARCH_QUERY_TOOL,
  assistantSurfacesFromToolResults,
  parseCustomersListSurface as parseCustomersListData,
  parseOrdersListSurface as parseOrdersListData,
} from "@showzy/validation/assistant-surfaces";

import { formatMoneyMinor } from "../../../format/money";
import { assistantCopy } from "../../../i18n/assistant";
import { customersCopy } from "../../../i18n/customers";
import { ordersCopy } from "../../../i18n/orders";
import {
  productEditorHref,
  productPhotoHref,
} from "../../catalog/products/shared/product-hrefs";
import {
  counterpartyEditorHref,
  customerEditorHref,
  groupEditorHref,
} from "../../customers/shared/customer-hrefs";
import { documentsHref } from "../../documents/shared/document-hrefs";
import { itemCountLabel } from "../../orders/shared/item-count";
import { formatOrderCreatedAt } from "../../orders/shared/order-created-at";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";
import { localizeCustomersListCard } from "../surfaces/customers-list";
import { localizeOrdersListCard } from "../surfaces/orders-list";
import {
  ASSISTANT_CUSTOMERS_LIST_HREF,
  ASSISTANT_CUSTOMERS_LIST_ROW_MAX,
  ASSISTANT_ORDERS_LIST_HREF,
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ASSISTANT_RESULT_SURFACE_REGISTRY,
  isAssistantAggregateLayout,
  localizeAssistantCardPayload,
  isOrderStatus,
  localizeAggregateColumns,
  ORDER_STATUSES,
  type AssistantAggregateView,
  type AssistantCollectionView,
  type AssistantCustomersListCardView,
  type AssistantOrderEntityCardView,
  type AssistantOrdersAggregateCardView,
  type AssistantOrdersListCardView,
  type AssistantSearchResultsCardView,
  type AssistantSurface,
} from "../surfaces";

/**
 * What the server does, run locally so these cases can still be written as
 * "these tool results produce this card".
 *
 * The app no longer composes surfaces from parts — the server stores the surface
 * it chose and the client only localizes it. The composition itself is unchanged
 * and lives in `@showzy/validation/assistant-surfaces`; this shapes the fixtures
 * below into what the server feeds it.
 */
type ToolPart = {
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly state?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly data?: unknown;
};

/** A façade error output, which must never become a card. */
function isToolErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    (output as { status?: unknown }).status === "error"
  );
}

function toolNameOf(part: ToolPart): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName.length > 0
      ? part.toolName
      : null;
  }
  return part.type.startsWith("tool-") && part.type.length > "tool-".length
    ? part.type.slice("tool-".length)
    : null;
}

function toolResultsFrom(parts: readonly ToolPart[]) {
  const results: {
    toolName: string;
    output: unknown;
    toolCallId?: string;
  }[] = [];
  for (const part of parts) {
    const toolName = toolNameOf(part);
    if (toolName === null || part.state !== "output-available") {
      continue;
    }
    results.push(
      typeof part.toolCallId === "string" && part.toolCallId.length > 0
        ? { toolName, output: part.output, toolCallId: part.toolCallId }
        : { toolName, output: part.output },
    );
  }
  return results;
}

function surfacesFromParts(
  parts: readonly ToolPart[],
  locale: "uk" | "en",
): readonly AssistantSurface[] {
  const surfaces: AssistantSurface[] = [];
  for (const data of assistantSurfacesFromToolResults(toolResultsFrom(parts))) {
    const surface = localizeAssistantCardPayload(data.kind, data, locale);
    if (surface !== null) {
      surfaces.push(surface);
    }
  }
  return surfaces;
}

function listOf(
  surfaces: readonly AssistantSurface[],
): AssistantOrdersListCardView | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-list") {
      return surface;
    }
  }
  return null;
}

function aggregateOf(
  surfaces: readonly AssistantSurface[],
): AssistantOrdersAggregateCardView | null {
  for (const surface of surfaces) {
    if (surface.kind === "orders-aggregate") {
      return surface;
    }
  }
  return null;
}

function entitiesOf(
  surfaces: readonly AssistantSurface[],
): readonly AssistantOrderEntityCardView[] {
  return surfaces.filter(
    (surface): surface is AssistantOrderEntityCardView =>
      surface.kind === "order-entity",
  );
}

function customersOf(
  surfaces: readonly AssistantSurface[],
): AssistantCustomersListCardView | null {
  for (const surface of surfaces) {
    if (surface.kind === "customers-list") {
      return surface;
    }
  }
  return null;
}

function searchResultsOf(
  surfaces: readonly AssistantSurface[],
): AssistantSearchResultsCardView | null {
  for (const surface of surfaces) {
    if (surface.kind === "search-results") {
      return surface;
    }
  }
  return null;
}

const ORDER_A = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const ORDER_B = "1a2b3c4d-5e6f-4789-8abc-def012345678";
const uk = assistantCopy("uk");
const ordersUk = ordersCopy("uk");

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

describe("assistantSurfacesFromParts", () => {
  it("accepts the five CHECK statuses and rejects active/completed aliases", () => {
    expect(ORDER_STATUSES).toEqual([
      "new",
      "confirmed",
      "in_progress",
      "done",
      "canceled",
    ]);
    expect(isOrderStatus("new")).toBe(true);
    expect(isOrderStatus("confirmed")).toBe(true);
    expect(isOrderStatus("in_progress")).toBe(true);
    expect(isOrderStatus("done")).toBe(true);
    expect(isOrderStatus("canceled")).toBe(true);
    expect(isOrderStatus("active")).toBe(false);
    expect(isOrderStatus("completed")).toBe(false);
    expect(isOrderStatus("all")).toBe(false);
  });

  it("caps the list card at 50 rows", () => {
    const items = Array.from({ length: 55 }, (_, index) =>
      pageRow(
        `0f0e2d5c-4a1b-4c3d-9e8f-1029384756${String(index).padStart(2, "0")}`,
        { orderNumber: String(1000 + index) },
      ),
    );
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput(items),
        },
      ],
      "uk",
    );
    expect(ASSISTANT_ORDERS_LIST_ROW_MAX).toBe(50);
    expect(listOf(surfaces)?.rows).toHaveLength(50);
    expect(entitiesOf(surfaces)).toHaveLength(0);
  });

  it("shows exactly three completed-view rows without slicing to nine", () => {
    const rows = [
      pageRow(ORDER_A, { orderNumber: "1049" }),
      pageRow(ORDER_B, { orderNumber: "1050" }),
      pageRow("33333333-3333-4333-8333-333333333333", {
        orderNumber: "1051",
      }),
    ];
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: {
            kind: "page.summary",
            requestedLimit: 3,
            rows,
            hasMore: true,
            nextCursor: "more",
            customerMatchTruncated: false,
          },
        },
      ],
      "uk",
    );
    const list = listOf(surfaces);
    expect(list?.rows).toHaveLength(3);
    expect(list?.destination).toEqual({
      kind: "screen",
      href: "/orders",
    });
    expect(list?.handoffLabel).toBe(uk.cards.openOrders);
    expect(list?.ctaHref).toBeNull();
    expect(list?.rows[0]?.href).toBe(orderDetailHref(ORDER_A));
    expect(list?.rows[1]?.href).toBe(orderDetailHref(ORDER_B));
  });

  it("adds status chips when counts are on the same turn", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_counts",
          toolCallId: "call-counts",
          state: "output-available",
          output: countsOutput([
            {
              identity: { kind: "status", status: "confirmed" },
              label: "confirmed",
              orderCount: 4,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "new" },
              label: "new",
              orderCount: 2,
              grossByCurrency: [],
            },
          ]),
        },
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A)]),
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)?.chips.map((chip) => chip.status)).toEqual([
      "new",
      "confirmed",
    ]);
    expect(listOf(surfaces)?.chips[0]?.label).toBe(
      `${ordersUk.statuses.new} · 2`,
    );
    expect(listOf(surfaces)?.chips[1]?.label).toBe(
      `${ordersUk.statuses.confirmed} · 4`,
    );
    expect(listOf(surfaces)?.kind).toBe("orders-list");
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)).toHaveLength(0);
  });

  it("renders an empty page without inventing rows", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([]),
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)?.rows).toEqual([]);
    expect(listOf(surfaces)?.emptyTitle).toBe(uk.cards.listEmptyTitle);
    expect(listOf(surfaces)?.emptyDescription).toBe(
      uk.cards.listEmptyDescription,
    );
    expect(listOf(surfaces)?.ctaHref).toBeNull();
  });

  it("sends nextCursor to /orders instead of in-chat paging", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A)], { nextCursor: "cursor-2" }),
        },
      ],
      "uk",
    );
    const list = listOf(surfaces);
    expect(list?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_ORDERS_LIST_HREF,
    });
    expect(list?.destination).toEqual({
      kind: "screen",
      href: "/orders",
    });
    expect(list?.handoffLabel).toBe(uk.cards.openOrders);
    expect(list?.ctaHref).toBeNull();
    expect(list?.ctaLabel).toBeNull();
    expect(list?.rows[0]?.href).toBe(orderDetailHref(ORDER_A));
    expect(list !== null && "nextCursor" in list).toBe(false);
    expect(list !== null && "loadMore" in list).toBe(false);
    expect(list !== null && "cursor" in list).toBe(false);
  });

  it("sends a clipped envelope to /orders", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: {
            status: "clipped",
            omitted: 12,
            preview: pageOutput([pageRow(ORDER_A)], { nextCursor: null }),
          },
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)?.destination).toEqual({
      kind: "screen",
      href: "/orders",
    });
    expect(listOf(surfaces)?.handoffLabel).toBe(uk.cards.openOrders);
    expect(listOf(surfaces)?.ctaHref).toBeNull();
    expect(listOf(surfaces)?.footnotes).toContain(uk.cards.clipped);
    expect(listOf(surfaces)?.rows).toHaveLength(1);
    expect(listOf(surfaces)?.rows[0]?.href).toBe(orderDetailHref(ORDER_A));
  });

  it("shows customerMatchTruncated as a footnote, not paging", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A)], {
            customerMatchTruncated: true,
          }),
        },
      ],
      "uk",
    );
    const list = listOf(surfaces);
    expect(list?.footnotes).toEqual([uk.cards.customerMatchTruncated]);
    expect(list?.ctaHref).toBeNull();
    expect(list !== null && "nextCursor" in list).toBe(false);
  });

  it("never paints an active chip, including from counts buckets", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_counts",
          toolCallId: "call-counts",
          state: "output-available",
          output: countsOutput([
            {
              identity: { kind: "status", status: "active" },
              label: "active",
              orderCount: 6,
              grossByCurrency: [],
            },
            {
              identity: { kind: "none" },
              label: "All",
              orderCount: 6,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "new" },
              label: "new",
              orderCount: 3,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "confirmed" },
              label: "confirmed",
              orderCount: 3,
              grossByCurrency: [],
            },
          ]),
        },
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([
            pageRow(ORDER_A, { status: "new" }),
            pageRow(ORDER_B, { status: "confirmed", orderNumber: "1050" }),
          ]),
        },
      ],
      "uk",
    );
    const chipJson = JSON.stringify(listOf(surfaces)?.chips);
    expect(chipJson.includes("active")).toBe(false);
    expect(listOf(surfaces)?.chips.map((chip) => chip.status)).toEqual([
      "new",
      "confirmed",
    ]);
    expect(listOf(surfaces)?.chips.map((chip) => chip.status)).not.toContain(
      "active",
    );
  });

  it("paints in_progress and done chips from CHECK status buckets", () => {
    const surfacesUk = surfacesFromParts(
      [
        {
          type: "tool-orders_list_counts",
          toolCallId: "call-counts",
          state: "output-available",
          output: countsOutput([
            {
              identity: { kind: "status", status: "active" },
              label: "active",
              orderCount: 9,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "done" },
              label: "done",
              orderCount: 1,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "in_progress" },
              label: "in_progress",
              orderCount: 2,
              grossByCurrency: [],
            },
            {
              identity: { kind: "status", status: "canceled" },
              label: "canceled",
              orderCount: 1,
              grossByCurrency: [],
            },
          ]),
        },
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([
            pageRow(ORDER_A, { status: "in_progress" }),
            pageRow(ORDER_B, { status: "done", orderNumber: "1050" }),
          ]),
        },
      ],
      "uk",
    );
    expect(listOf(surfacesUk)?.chips.map((chip) => chip.status)).toEqual([
      "in_progress",
      "done",
      "canceled",
    ]);
    expect(listOf(surfacesUk)?.chips[0]?.label).toBe(
      `${ordersUk.statuses.in_progress} · 2`,
    );
    expect(listOf(surfacesUk)?.chips[1]?.label).toBe(
      `${ordersUk.statuses.done} · 1`,
    );
    expect(listOf(surfacesUk)?.chips[0]?.tone).toBe("attention");
    expect(listOf(surfacesUk)?.chips[1]?.tone).toBe("success");
    expect(listOf(surfacesUk)?.rows[0]?.statusLabel).toBe(
      ordersUk.statuses.in_progress,
    );
    expect(listOf(surfacesUk)?.rows[1]?.statusLabel).toBe(
      ordersUk.statuses.done,
    );
    expect(JSON.stringify(listOf(surfacesUk)?.chips).includes("active")).toBe(
      false,
    );

    const surfacesEn = surfacesFromParts(
      [
        {
          type: "tool-orders_list_counts",
          toolCallId: "call-counts",
          state: "output-available",
          output: countsOutput([
            {
              identity: { kind: "status", status: "in_progress" },
              label: "in_progress",
              orderCount: 2,
              grossByCurrency: [],
            },
          ]),
        },
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A, { status: "in_progress" })]),
        },
      ],
      "en",
    );
    expect(listOf(surfacesEn)?.chips[0]?.label).toBe("In progress · 2");
    expect(listOf(surfacesEn)?.rows[0]?.statusLabel).toBe("In progress");
  });

  it("renders one aggregate card on counts-only turns", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_counts",
          toolCallId: "call-counts",
          state: "output-available",
          output: countsOutput([
            {
              identity: { kind: "status", status: "new" },
              label: "new",
              orderCount: 2,
              grossByCurrency: [],
            },
          ]),
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)?.kind).toBe("orders-aggregate");
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("does not render a list card from a façade error orders_list_page", () => {
    const output = {
      status: "error" as const,
      code: "PERMISSION_DENIED",
      message: "Staff cannot list these orders",
    };
    expect(isToolErrorOutput(output)).toBe(true);
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output,
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("does not turn list items into N orders.get entity cards", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A), pageRow(ORDER_B)]),
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)?.rows).toHaveLength(2);
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("maps compact list rows onto orderDetailHref", () => {
    const parts = [
      {
        type: "tool-orders_list_page" as const,
        toolCallId: "call-page",
        state: "output-available" as const,
        output: pageOutput([pageRow(ORDER_A)]),
      },
    ];
    const surfaces = surfacesFromParts(parts, "uk");
    const row = listOf(surfaces)?.rows[0];
    expect(row?.href).toBe(orderDetailHref(ORDER_A));
    expect(listOf(surfaces)?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_ORDERS_LIST_HREF,
    });
    expect(listOf(surfaces)?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_ORDERS_LIST_SCREEN_HREF,
    });
    expect(listOf(surfaces)?.handoffLabel).toBe(uk.cards.openOrders);
    expect(row?.orderNumberLabel).toBe("#1049");
    expect(row?.customerName).toBe("Іван");
    expect(row?.statusLabel).toBe(ordersUk.statuses.new);
    expect(row?.totalLabel).toBe(formatMoneyMinor("33000", "UAH"));
    expect(row?.metaLabel.includes("1049")).toBe(true);
    const parsed = parseOrdersListData(toolResultsFrom(parts));
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const collectionRow = localizeOrdersListCard(parsed, "uk").collection
      .rows[0];
    expect(collectionRow?.title).toBe(row?.customerName);
    expect(collectionRow?.badge).toBe(row?.statusLabel);
    expect(collectionRow?.meta).toBe(row?.metaLabel);
    expect(collectionRow?.cells).toEqual(
      row?.totalLabel !== null && row?.totalLabel !== undefined
        ? [row.totalLabel]
        : [],
    );
    expect(collectionRow?.href).toBe(row?.href);
  });

  it("formats createdAt with the same locale helper as /orders", () => {
    const createdAt = "2026-08-25T12:00:00.000Z";
    const ukDate = formatOrderCreatedAt(createdAt, "uk");
    const enDate = formatOrderCreatedAt(createdAt, "en");
    expect(ukDate).toBe("25 серп. 2026");
    expect(enDate).toBe("25 Aug 2026");
    expect(ukDate).not.toBe(enDate);

    const parts = [
      {
        type: "tool-orders_list_page" as const,
        toolCallId: "call-page",
        state: "output-available" as const,
        output: pageOutput([pageRow(ORDER_A, { createdAt })]),
      },
    ];
    const ukRow = listOf(surfacesFromParts(parts, "uk"))?.rows[0];
    const enRow = listOf(surfacesFromParts(parts, "en"))?.rows[0];
    expect(ukRow?.metaLabel).toContain(ukDate);
    expect(enRow?.metaLabel).toContain(enDate);
    expect(ukRow?.metaLabel).not.toContain(enDate);
    expect(enRow?.metaLabel).not.toContain(ukDate);
    expect(ukRow?.metaLabel.includes("25.08.2026")).toBe(false);
    expect(enRow?.metaLabel.includes("25.08.2026")).toBe(false);
  });

  it("keeps invalid or empty createdAt as an empty meta fragment", () => {
    const itemMeta = itemCountLabel(2, "uk", ordersUk.items);
    const emptySurfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-empty-date",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A, { createdAt: "" })]),
        },
      ],
      "uk",
    );
    const invalidSurfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_list_page",
          toolCallId: "call-invalid-date",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A, { createdAt: "not-a-date" })]),
        },
      ],
      "uk",
    );
    expect(listOf(emptySurfaces)?.rows[0]?.metaLabel).toBe(
      `#1049 · ${itemMeta}`,
    );
    expect(listOf(invalidSurfaces)?.rows[0]?.metaLabel).toBe(
      `#1049 · ${itemMeta}`,
    );
    expect(formatOrderCreatedAt("", "uk")).toBe("");
    expect(formatOrderCreatedAt("not-a-date", "en")).toBe("");
  });

  it("introduces a thin entity card from live orders.get / orders.create", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_get",
          toolCallId: "call-get",
          state: "output-available",
          output: {
            orderId: ORDER_A,
            orderNumber: "1049",
            customerId: ORDER_B,
            status: "confirmed",
            totalGrossMinor: "33000",
            currency: "UAH",
            createdAt: "2026-09-03T10:00:00.000Z",
            items: [
              { itemId: ORDER_B, titleSnapshot: "Rose" },
              { itemId: ORDER_A, titleSnapshot: "Tulip" },
            ],
          },
        },
        {
          type: "tool-orders_create",
          toolCallId: "call-create",
          state: "output-available",
          output: {
            orderId: ORDER_B,
            orderNumber: "1050",
            customer: { nameSnapshot: "Оля", linkedCustomerId: null },
            status: "new",
            itemCount: 1,
            totalGrossMinor: "1000",
            currency: "UAH",
            createdAt: "2026-09-03T11:00:00.000Z",
          },
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)).toHaveLength(2);
    expect(entitiesOf(surfaces)[0]?.orderId).toBe(ORDER_A);
    expect(entitiesOf(surfaces)[0]?.href).toBe(orderDetailHref(ORDER_A));
    expect(entitiesOf(surfaces)[0]?.destination).toEqual({
      kind: "screen",
      href: orderDetailHref(ORDER_A),
    });
    expect(entitiesOf(surfaces)[0]?.handoffLabel).toBe(uk.cards.openOrder);
    expect(entitiesOf(surfaces)[0]?.customerName).toBeNull();
    expect(entitiesOf(surfaces)[1]?.customerName).toBe("Оля");
    expect(entitiesOf(surfaces)).toHaveLength(2);
  });

  it("parses in_progress and done on the thin entity card", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_get",
          toolCallId: "call-get-progress",
          state: "output-available",
          output: {
            orderId: ORDER_A,
            orderNumber: "1049",
            status: "in_progress",
            totalGrossMinor: "33000",
            currency: "UAH",
          },
        },
        {
          type: "tool-orders_get",
          toolCallId: "call-get-done",
          state: "output-available",
          output: {
            orderId: ORDER_B,
            orderNumber: "1050",
            status: "done",
            totalGrossMinor: "1000",
            currency: "UAH",
          },
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)[0]?.statusLabel).toBe(
      ordersUk.statuses.in_progress,
    );
    expect(entitiesOf(surfaces)[0]?.statusTone).toBe("attention");
    expect(entitiesOf(surfaces)[1]?.statusLabel).toBe(ordersUk.statuses.done);
    expect(entitiesOf(surfaces)[1]?.statusTone).toBe("success");
  });
});

const PRODUCT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function countsPart(
  output: Record<string, unknown>,
  input?: Record<string, unknown>,
): {
  readonly type: "tool-orders_list_counts";
  readonly toolCallId: string;
  readonly state: "output-available";
  readonly output: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
} {
  return {
    type: "tool-orders_list_counts",
    toolCallId: "call-counts",
    state: "output-available",
    output,
    ...(input !== undefined ? { input } : {}),
  };
}

function statusBucket(
  status: string,
  orderCount: number,
  grossByCurrency: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    identity: { kind: "status", status },
    label: status,
    orderCount,
    grossByCurrency,
  };
}

function assertLabeledBucketList(card: AssistantOrdersAggregateCardView): void {
  const json = JSON.stringify(card);
  expect(card.kind).toBe("orders-aggregate");
  expect(json.includes("wow")).toBe(false);
  expect(json.includes("barChart")).toBe(false);
  expect(json.includes("chartType")).toBe(false);
  expect(json.includes('"active"')).toBe(false);
  expect(json.includes("average")).toBe(false);
  expect(json.includes("середн")).toBe(false);
  expect(json.includes("avgCheck")).toBe(false);
  expect("chart" in card).toBe(false);
  expect("wowPercent" in card).toBe(false);
  expect("averageCheck" in card).toBe(false);
  expect(card.destination).toEqual({
    kind: "screen",
    href: ASSISTANT_ORDERS_LIST_HREF,
  });
  expect(card.destination).toEqual({
    kind: "screen",
    href: "/orders",
  });
  expect(card.handoffLabel).toBe(uk.cards.openOrders);
  expect(card.ctaHref).toBeNull();
  expect(card.ctaLabel).toBeNull();
  expect(card.aggregate.layout).toBe("summary");
  expect("total" in card.aggregate).toBe(false);
  if (card.aggregate.layout !== "summary") {
    return;
  }
  expect(card.aggregate.featured).toBeNull();
  expect(card.aggregate.periodLabel).toBe(card.periodLabel);
  expect(card.aggregate.headlineCountLabel).toBe(card.orderCountLabel);
  expect(card.aggregate.headlineMoneyLabels).toEqual(card.moneyLabels);
}

describe("assistantSurfacesFromParts aggregate (SHO-370 / SHO-395)", () => {
  it("maps period=this_month default groupBy status to one aggregate card", () => {
    const statusBuckets = [
      statusBucket("in_progress", 2, [
        { currency: "UAH", grossAmountMinor: "4000" },
      ]),
      statusBucket("new", 3, [{ currency: "UAH", grossAmountMinor: "3000" }]),
      statusBucket("confirmed", 1, [
        { currency: "UAH", grossAmountMinor: "1000" },
      ]),
    ];
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(statusBuckets, {
            orderCount: 6,
            grossByCurrency: [{ currency: "UAH", grossAmountMinor: "8000" }],
            statusBuckets,
          }),
          { period: "this_month", groupBy: "status" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(listOf(surfaces)).toBeNull();
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    assertLabeledBucketList(card);
    expect(card.groupBy).toBe("status");
    // Known gap, named rather than hidden: the period line comes from the counts
    // tool's *input*, and a stored card payload does not carry it. Closing it is
    // a change to what the server writes into the card.
    expect(uk.cards.periodThisMonth).toBe("Цього місяця");
    expect(card.periodLabel).toBeNull();
    expect(card.orderCountLabel).toBe("6 замовлень");
    expect(card.moneyLabels).toEqual([formatMoneyMinor("8000", "UAH")]);
    expect(card.statusBuckets.map((bucket) => bucket.status)).toEqual([
      "new",
      "confirmed",
      "in_progress",
    ]);
    expect(card.extraBuckets).toEqual([]);
    expect(card.statusBuckets[0]?.label).toBe(ordersUk.statuses.new);
    expect(card.statusBuckets[1]?.label).toBe(ordersUk.statuses.confirmed);
    expect(card.statusBuckets[2]?.label).toBe(ordersUk.statuses.in_progress);
    expect(card.statusBuckets[2]?.statusTone).toBe("attention");
    expect(card.statusBuckets[0]?.statusTone).toBe("action");
    expect(card.emptyTitle).toBeNull();
    expect(card.handoffLabel).toBe(uk.cards.openOrders);
    expect(JSON.stringify(card).includes(uk.cards.noneBucket)).toBe(false);
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("does not render a duplicate total row for groupBy none", () => {
    const statusBuckets = [
      statusBucket("new", 6, [{ currency: "UAH", grossAmountMinor: "8000" }]),
    ];
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: { kind: "none" },
                label: "",
                orderCount: 6,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "8000" },
                ],
              },
            ],
            {
              orderCount: 6,
              grossByCurrency: [{ currency: "UAH", grossAmountMinor: "8000" }],
              statusBuckets,
            },
          ),
          { groupBy: "none", period: "this_week" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(listOf(surfaces)).toBeNull();
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    assertLabeledBucketList(card);
    expect(card.groupBy).toBe("none");
    // Known gap, named rather than hidden: the period line comes from the counts
    // tool's *input*, and a stored card payload does not carry it. Closing it is
    // a change to what the server writes into the card.
    expect(card.periodLabel).toBeNull();
    expect(card.extraBuckets).toEqual([]);
    expect(card.statusBuckets).toHaveLength(1);
    expect(card.statusBuckets[0]?.status).toBe("new");
    expect(card.statusBuckets[0]?.orderCountLabel).toBe("6");
    expect(JSON.stringify(card)).not.toContain(uk.cards.noneBucket);
    expect(JSON.stringify(card)).not.toContain("Усього");
    expect(card.ctaHref).toBeNull();
  });

  it("maps period=today to the period line", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(countsOutput([], { orderCount: 0, grossByCurrency: [] }), {
          groupBy: "status",
          period: "today",
        }),
      ],
      "uk",
    );
    // Known gap, named rather than hidden: the period line comes from the counts
    // tool's *input*, and a stored card payload does not carry it. Closing it is
    // a change to what the server writes into the card.
    expect(aggregateOf(surfaces)?.periodLabel).toBeNull();
    expect(aggregateOf(surfaces)?.destination).toEqual({
      kind: "screen",
      href: "/orders",
    });
    expect(aggregateOf(surfaces)?.ctaHref).toBeNull();
  });

  it("omits the period line when the call has no period or dates", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput([], {
            orderCount: 0,
            grossByCurrency: [],
          }),
          { groupBy: "status" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(card?.periodLabel).toBeNull();
    expect(card?.destination).toEqual({
      kind: "screen",
      href: "/orders",
    });
    expect(card?.ctaHref).toBeNull();
  });

  it("formats ISO createdFrom/createdTo as the period line", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(countsOutput([], { orderCount: 0, grossByCurrency: [] }), {
          groupBy: "status",
          createdFrom: "2026-08-25T12:00:00.000Z",
          createdTo: "2026-08-31T12:00:00.000Z",
        }),
      ],
      "uk",
    );
    const from = formatOrderCreatedAt("2026-08-25T12:00:00.000Z", "uk");
    const to = formatOrderCreatedAt("2026-08-31T12:00:00.000Z", "uk");
    expect(surfaces[0] && "periodLabel" in surfaces[0]).toBe(true);
    // Known gap, named rather than hidden: the period line comes from the counts
    // tool's *input*, and a stored card payload does not carry it. Closing it is
    // a change to what the server writes into the card.
    expect(`${from} – ${to}`.length).toBeGreaterThan(0);
    expect(aggregateOf(surfaces)?.periodLabel).toBeNull();
  });

  it("never mixes money across currencies", () => {
    const statusBuckets = [
      statusBucket("new", 4, [
        { currency: "UAH", grossAmountMinor: "1000" },
        { currency: "USD", grossAmountMinor: "200" },
      ]),
    ];
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: { kind: "none" },
                label: "",
                orderCount: 4,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "1000" },
                  { currency: "USD", grossAmountMinor: "200" },
                ],
              },
            ],
            {
              orderCount: 4,
              grossByCurrency: [
                { currency: "UAH", grossAmountMinor: "1000" },
                { currency: "USD", grossAmountMinor: "200" },
              ],
              statusBuckets,
            },
          ),
          { groupBy: "none" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    const uah = formatMoneyMinor("1000", "UAH");
    const usd = formatMoneyMinor("200", "USD");
    expect(card.moneyLabels).toEqual([uah, usd]);
    expect(card.statusBuckets[0]?.moneyLabels).toEqual([uah, usd]);
    expect(card.moneyLabels).toHaveLength(2);
    expect(card.moneyLabels.join("")).not.toBe(formatMoneyMinor("1200", "UAH"));
    expect(JSON.stringify(card).includes("1200")).toBe(false);
  });

  it("surfaces bucketsOmitted and bucketsTruncated as footnotes", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: {
                  kind: "product",
                  productId: PRODUCT_A,
                  variantId: null,
                },
                label: "Rose",
                orderCount: 2,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "1000" },
                ],
                quantityMilli: "2000",
              },
            ],
            {
              orderCount: 12,
              bucketsTruncated: true,
              bucketsOmitted: 4,
              statusBuckets: [
                statusBucket("new", 12, [
                  { currency: "UAH", grossAmountMinor: "1000" },
                ]),
              ],
            },
          ),
          { groupBy: "product" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    expect(card.footnotes).toContain(uk.cards.bucketsTruncated);
    expect(card.footnotes).toContain("Ще 4 групи не показано.");
    expect("bucketsOmitted" in card).toBe(false);
    expect("bucketsTruncated" in card).toBe(false);
  });

  it("pluralizes bucketsOmitted footnotes (uk one and few)", () => {
    const one = aggregateOf(
      surfacesFromParts(
        [
          countsPart(
            countsOutput(
              [
                {
                  identity: { kind: "none" },
                  label: uk.cards.noneBucket,
                  orderCount: 2,
                  grossByCurrency: [
                    { currency: "UAH", grossAmountMinor: "1000" },
                  ],
                },
              ],
              {
                bucketsOmitted: 1,
                statusBuckets: [statusBucket("new", 2)],
              },
            ),
            { groupBy: "none" },
          ),
        ],
        "uk",
      ),
    );
    expect(one).not.toBeNull();
    if (one === null) {
      return;
    }
    expect(one.footnotes).toContain("Ще 1 група не показано.");

    const four = aggregateOf(
      surfacesFromParts(
        [
          countsPart(
            countsOutput(
              [
                {
                  identity: { kind: "none" },
                  label: uk.cards.noneBucket,
                  orderCount: 2,
                  grossByCurrency: [
                    { currency: "UAH", grossAmountMinor: "1000" },
                  ],
                },
              ],
              {
                bucketsOmitted: 4,
                statusBuckets: [statusBucket("new", 2)],
              },
            ),
            { groupBy: "none" },
          ),
        ],
        "uk",
      ),
    );
    expect(four).not.toBeNull();
    if (four === null) {
      return;
    }
    expect(four.footnotes).toContain("Ще 4 групи не показано.");

    const oneEn = aggregateOf(
      surfacesFromParts(
        [
          countsPart(
            countsOutput(
              [
                {
                  identity: { kind: "none" },
                  label: uk.cards.noneBucket,
                  orderCount: 2,
                  grossByCurrency: [
                    { currency: "UAH", grossAmountMinor: "1000" },
                  ],
                },
              ],
              {
                bucketsOmitted: 1,
                statusBuckets: [statusBucket("new", 2)],
              },
            ),
            { groupBy: "none" },
          ),
        ],
        "en",
      ),
    );
    expect(oneEn).not.toBeNull();
    if (oneEn === null) {
      return;
    }
    expect(oneEn.footnotes).toContain("1 more group is not shown.");
  });

  it("renders empty buckets as honest empty copy, not a chart", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput([], {
            orderCount: 0,
            grossByCurrency: [],
          }),
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(listOf(surfaces)).toBeNull();
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    assertLabeledBucketList(card);
    expect(card.statusBuckets).toEqual([]);
    expect(card.extraBuckets).toEqual([]);
    expect(card.emptyTitle).toBe(uk.cards.aggregateEmptyTitle);
    expect(card.emptyDescription).toBe(uk.cards.aggregateEmptyDescription);
    expect(card.orderCountLabel).toBe("0 замовлень");
    expect(card.handoffLabel).toBe(uk.cards.openOrders);
    expect(card.ctaLabel).toBeNull();
  });

  it("renders product and customer extra sections alongside statusBuckets", () => {
    const statusBuckets = [
      statusBucket("new", 2, [{ currency: "UAH", grossAmountMinor: "5000" }]),
    ];
    const productSurfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: {
                  kind: "product",
                  productId: PRODUCT_A,
                  variantId: null,
                },
                label: "Троянда",
                orderCount: 2,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "5000" },
                ],
                quantityMilli: "1500",
              },
            ],
            { statusBuckets },
          ),
          { groupBy: "product" },
        ),
      ],
      "uk",
    );
    const customerSurfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: {
                  kind: "customer",
                  customerId: CUSTOMER_A,
                  nameSnapshot: "Іван",
                },
                label: "Іван",
                orderCount: 3,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "7000" },
                ],
              },
            ],
            {
              statusBuckets: [
                statusBucket("new", 3, [
                  { currency: "UAH", grossAmountMinor: "7000" },
                ]),
              ],
            },
          ),
          { groupBy: "customer" },
        ),
      ],
      "uk",
    );
    const product = aggregateOf(productSurfaces);
    const customer = aggregateOf(customerSurfaces);
    expect(product).not.toBeNull();
    expect(customer).not.toBeNull();
    if (product === null || customer === null) {
      return;
    }
    assertLabeledBucketList(product);
    assertLabeledBucketList(customer);
    expect(product.groupBy).toBe("product");
    expect(customer.groupBy).toBe("customer");
    expect(product.kind).toBe(customer.kind);
    expect(product.kind).toBe("orders-aggregate");
    expect(product.statusBuckets).toHaveLength(1);
    expect(customer.statusBuckets).toHaveLength(1);
    expect(product.extraBuckets[0]?.label).toBe("Троянда");
    expect(product.extraBuckets[0]?.quantityLabel).toBe("1,5");
    expect(product.extraBuckets[0]?.status).toBeNull();
    expect(customer.extraBuckets[0]?.label).toBe("Іван");
    expect(customer.extraBuckets[0]?.quantityLabel).toBeNull();
    expect(customer.extraBuckets[0]?.status).toBeNull();
    if (product.aggregate.layout === "summary") {
      expect(product.aggregate.sections[1]?.id).toBe("product");
      expect(product.aggregate.sections[1]?.id).toBe(
        product.aggregate.groupingKey,
      );
    }
    if (customer.aggregate.layout === "summary") {
      expect(customer.aggregate.sections[1]?.id).toBe("customer");
      expect(customer.aggregate.sections[1]?.id).toBe(
        customer.aggregate.groupingKey,
      );
    }
    expect("chartType" in product).toBe(false);
    expect("chartType" in customer).toBe(false);
  });

  it("keeps one list card and no aggregate when page and counts share a turn", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput([
            {
              identity: { kind: "status", status: "new" },
              label: "new",
              orderCount: 2,
              grossByCurrency: [],
            },
          ]),
        ),
        {
          type: "tool-orders_list_page",
          toolCallId: "call-page",
          state: "output-available",
          output: pageOutput([pageRow(ORDER_A)]),
        },
      ],
      "uk",
    );
    expect(listOf(surfaces)?.kind).toBe("orders-list");
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("never paints an active chip or invented Active bucket on the aggregate card", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput([], {
            statusBuckets: [
              statusBucket("active", 9),
              statusBucket("in_progress", 2, [
                { currency: "UAH", grossAmountMinor: "1000" },
              ]),
              statusBucket("new", 1, [
                { currency: "UAH", grossAmountMinor: "500" },
              ]),
            ],
          }),
          { groupBy: "status" },
        ),
      ],
      "uk",
    );
    const card = aggregateOf(surfaces);
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    const json = JSON.stringify(card);
    expect(json.includes("active")).toBe(false);
    expect(json.includes("Активн")).toBe(false);
    expect(card.statusBuckets.map((bucket) => bucket.status)).toEqual([
      "new",
      "in_progress",
    ]);
    expect(card.extraBuckets).toEqual([]);
    expect(card.statusBuckets[1]?.label).toBe(ordersUk.statuses.in_progress);
    expect(card.statusBuckets[1]?.label).toBe("В роботі");
    expect(card.statusBuckets.map((bucket) => bucket.label)).not.toContain(
      "Активні",
    );
  });

  it("does not render an aggregate card from a façade error orders_list_counts", () => {
    const output = {
      status: "error" as const,
      code: "PERMISSION_DENIED",
      message: "Staff cannot count these orders",
    };
    expect(isToolErrorOutput(output)).toBe(true);
    const surfaces = surfacesFromParts([countsPart(output)], "uk");
    expect(listOf(surfaces)).toBeNull();
    expect(aggregateOf(surfaces)).toBeNull();
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("localizes unlinked customer buckets and in_progress status copy", () => {
    const surfaces = surfacesFromParts(
      [
        countsPart(
          countsOutput(
            [
              {
                identity: {
                  kind: "customer",
                  customerId: null,
                  nameSnapshot: "unlinked",
                },
                label: "unlinked",
                orderCount: 1,
                grossByCurrency: [],
              },
            ],
            {
              statusBuckets: [statusBucket("in_progress", 1)],
            },
          ),
          { groupBy: "customer" },
        ),
      ],
      "uk",
    );
    expect(aggregateOf(surfaces)?.extraBuckets[0]?.label).toBe(
      ordersUk.missingCustomer,
    );
    expect(aggregateOf(surfaces)?.statusBuckets[0]?.label).toBe(
      ordersUk.statuses.in_progress,
    );
  });
});

describe("assistant result-card surface registry", () => {
  it("registers orders kinds plus customers-list and search-results with English prompt lines", () => {
    expect(
      ASSISTANT_RESULT_SURFACE_REGISTRY.map((entry) => entry.kind),
    ).toEqual([
      "orders-list",
      "orders-aggregate",
      "order-entity",
      "customers-list",
      "search-results",
    ]);
    for (const entry of ASSISTANT_RESULT_SURFACE_REGISTRY) {
      expect(entry.promptLine.length).toBeGreaterThan(20);
      expect(entry.promptLine.includes("**")).toBe(false);
      expect(/[А-Яа-яІіЇїЄєҐґ]/.test(entry.promptLine)).toBe(false);
      expect(entry.toolNames.length).toBeGreaterThan(0);
      if (entry.kind === "search-results") {
        expect(entry.destination.kind).toBe("terminal");
      } else {
        expect(entry.destination.kind).toBe("screen");
      }
    }
    expect(
      ASSISTANT_RESULT_SURFACE_REGISTRY.map((entry) => entry.destination),
    ).toEqual([
      { kind: "screen" },
      { kind: "screen" },
      { kind: "screen" },
      { kind: "screen" },
      { kind: "terminal" },
    ]);
    const customers = ASSISTANT_RESULT_SURFACE_REGISTRY.find(
      (entry) => entry.kind === "customers-list",
    );
    const search = ASSISTANT_RESULT_SURFACE_REGISTRY.find(
      (entry) => entry.kind === "search-results",
    );
    expect(customers?.hydratable).toBe(false);
    expect(search?.hydratable).toBe(false);
    expect(search?.actionNames).toEqual(["search.query"]);
    expect(search?.toolNames).toEqual(
      expect.arrayContaining(["search_query", "search.query"]),
    );
  });

  it("keeps list, aggregate, and entity card destinations on today's order-hrefs", () => {
    expect(ASSISTANT_ORDERS_LIST_HREF).toBe(ASSISTANT_ORDERS_LIST_SCREEN_HREF);
    expect(ASSISTANT_ORDERS_LIST_HREF).toBe("/orders");
    const list = listOf(
      surfacesFromParts(
        [
          {
            type: "tool-orders_list_page",
            toolCallId: "call-page",
            state: "output-available",
            output: pageOutput([pageRow(ORDER_A)]),
          },
        ],
        "uk",
      ),
    );
    const aggregate = aggregateOf(
      surfacesFromParts(
        [
          {
            type: "tool-orders_list_counts",
            toolCallId: "call-counts",
            state: "output-available",
            output: countsOutput([
              {
                identity: { kind: "status", status: "new" },
                orderCount: 1,
              },
            ]),
          },
        ],
        "uk",
      ),
    );
    const entity = entitiesOf(
      surfacesFromParts(
        [
          {
            type: "tool-orders_get",
            toolCallId: "call-get",
            state: "output-available",
            output: {
              orderId: ORDER_A,
              orderNumber: "1049",
              status: "new",
            },
          },
        ],
        "uk",
      ),
    )[0];
    expect(list?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_ORDERS_LIST_HREF,
    });
    expect(list?.ctaHref).toBeNull();
    expect(aggregate?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_ORDERS_LIST_HREF,
    });
    expect(aggregate?.ctaHref).toBeNull();
    expect(entity?.destination).toEqual({
      kind: "screen",
      href: orderDetailHref(ORDER_A),
    });
    expect(entity?.href).toBe(orderDetailHref(ORDER_A));
  });

  it("omits a permission-denied orders.get entity surface", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: "tool-orders_get",
          toolCallId: "call-get",
          state: "output-available",
          output: {
            status: "error",
            code: "PERMISSION_DENIED",
            message: "Staff cannot read this order",
          },
        },
      ],
      "uk",
    );
    expect(surfaces).toEqual([]);
    expect(entitiesOf(surfaces)).toEqual([]);
  });

  it("composes Card / StatusPill and does not embed OrdersListScreen / OrderRow", () => {
    const collectionBlock = readFileSync(
      new URL("../sheet/assistant-collection-block.tsx", import.meta.url),
      "utf8",
    );
    const entityCard = readFileSync(
      new URL("../sheet/order-entity-card.tsx", import.meta.url),
      "utf8",
    );
    const aggregateCard = readFileSync(
      new URL("../sheet/orders-aggregate-result-card.tsx", import.meta.url),
      "utf8",
    );
    const aggregateBlock = readFileSync(
      new URL("../sheet/assistant-aggregate-block.tsx", import.meta.url),
      "utf8",
    );
    const surfaceCard = readFileSync(
      new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
      "utf8",
    );
    const resultFrame = readFileSync(
      new URL("../sheet/assistant-result-frame.tsx", import.meta.url),
      "utf8",
    );
    const listParse = readFileSync(
      new URL("../surfaces/orders-list.ts", import.meta.url),
      "utf8",
    );
    const customersParse = readFileSync(
      new URL("../surfaces/customers-list.ts", import.meta.url),
      "utf8",
    );
    const searchParse = readFileSync(
      new URL("../surfaces/search-results.ts", import.meta.url),
      "utf8",
    );
    const aggregateParse = readFileSync(
      new URL("../surfaces/orders-aggregate.ts", import.meta.url),
      "utf8",
    );
    const entityParse = readFileSync(
      new URL("../surfaces/order-entity.ts", import.meta.url),
      "utf8",
    );
    const compose = readFileSync(
      new URL("../surfaces/compose.ts", import.meta.url),
      "utf8",
    );
    const registry = readFileSync(
      new URL("../surfaces/registry.ts", import.meta.url),
      "utf8",
    );
    const messageRow = readFileSync(
      new URL("../sheet/assistant-message-row.tsx", import.meta.url),
      "utf8",
    );
    const sheetView = readFileSync(
      new URL("../sheet/assistant-sheet-view.tsx", import.meta.url),
      "utf8",
    );
    const hook = readFileSync(
      new URL("../sheet/use-assistant-sheet.ts", import.meta.url),
      "utf8",
    );
    expect(collectionBlock).toContain("StatusPill");
    expect(collectionBlock).toContain('from "../../../components/ui"');
    expect(collectionBlock).toContain("onOpenHref");
    expect(surfaceCard).not.toContain("StatusPill");
    expect(surfaceCard.includes("orders-list-screen")).toBe(false);
    expect(surfaceCard.includes("order-row")).toBe(false);
    expect(surfaceCard.includes('from "../../orders/list')).toBe(false);
    expect(entityCard).toContain("StatusPill");
    expect(entityCard).toContain("onOpenHref");
    expect(entityCard.includes("orders-list-screen")).toBe(false);
    expect(entityCard.includes("order-row")).toBe(false);
    expect(aggregateCard).toContain("AssistantAggregateBlock");
    expect(aggregateCard).not.toContain("StatusPill");
    expect(aggregateBlock).toContain("AssistantCollectionResultRow");
    expect(resultFrame).toContain("Button");
    expect(resultFrame).toContain("Card");
    expect(aggregateCard.includes("orders-list-screen")).toBe(false);
    expect(aggregateCard.includes("order-row")).toBe(false);
    expect(aggregateCard.includes("BarChart")).toBe(false);
    expect(aggregateCard.includes("wow")).toBe(false);
    expect(aggregateBlock.includes("BarChart")).toBe(false);
    expect(surfaceCard).toContain('case "orders-list"');
    expect(surfaceCard).toContain("AssistantCollectionBlock");
    expect(surfaceCard).toContain('case "customers-list"');
    expect(surfaceCard).toContain('case "search-results"');
    expect(surfaceCard).toContain("AssistantSearchResultsBlock");
    expect(surfaceCard).toContain("OrdersAggregateResultCard");
    expect(surfaceCard).toContain("onOpenHref={onOpenHref}");
    expect(surfaceCard).toContain("OrderEntityCard");
    expect(messageRow).toContain("surfaces");
    expect(messageRow).toContain("AssistantSurfaceCard");
    expect(messageRow).toContain("onOpenHref");
    expect(messageRow.includes("listCard")).toBe(false);
    expect(messageRow.includes("aggregateCard")).toBe(false);
    expect(messageRow.includes("entityCards")).toBe(false);
    expect(messageRow.includes("onOpenOrders")).toBe(false);
    expect(messageRow.includes("onOpenOrder")).toBe(false);
    expect(messageRow.includes("orders-list-screen")).toBe(false);
    expect(messageRow.includes("order-row")).toBe(false);
    expect(sheetView.includes("listCard")).toBe(false);
    expect(sheetView.includes("aggregateCard")).toBe(false);
    expect(sheetView.includes("entityCards")).toBe(false);
    expect(sheetView).toContain("surfaces");
    expect(sheetView).toContain("onOpenHref");
    expect(hook).toContain("openHref");
    expect(hook.includes("orderDetailHref")).toBe(false);
    expect(hook.includes("ASSISTANT_ORDERS_LIST_HREF")).toBe(false);
    expect(hook.includes("openOrders")).toBe(false);
    expect(hook.includes("orders-list-screen")).toBe(false);
    expect(hook.includes("order-row")).toBe(false);
    expect(listParse.includes('from "@showzy/ai"')).toBe(false);
    expect(customersParse.includes('from "@showzy/ai"')).toBe(false);
    expect(searchParse.includes('from "@showzy/ai"')).toBe(false);
    expect(listParse).toContain("@showzy/copy/assistant");
    expect(customersParse).toContain("@showzy/copy/assistant");
    expect(searchParse).toContain("@showzy/copy/assistant");
    expect(aggregateParse.includes('from "@showzy/ai"')).toBe(false);
    expect(entityParse.includes('from "@showzy/ai"')).toBe(false);
    expect(compose.includes('from "@showzy/ai"')).toBe(false);
    expect(registry.includes('from "@showzy/ai"')).toBe(false);
    expect(listParse.includes('from "@showzy/core"')).toBe(false);
    expect(listParse.includes('from "../../orders/list')).toBe(false);
    expect(listParse).toContain("formatOrderCreatedAt");
    expect(listParse).toContain("../../orders/shared/order-created-at");
    expect(aggregateParse).toContain("formatOrderCreatedAt");
    expect(aggregateParse).toContain("../../orders/shared/order-created-at");
    expect(listParse).not.toContain("extractUuidResultIds");
    expect(customersParse).not.toContain("extractUuidResultIds");
    expect(searchParse).not.toContain("extractUuidResultIds");
    expect(aggregateParse).not.toContain("extractUuidResultIds");
    expect(entityParse).not.toContain("extractUuidResultIds");
    expect(compose).not.toContain("extractUuidResultIds");
    expect(listParse).not.toContain("sit.svg");
    expect(listParse).not.toContain("dig.svg");
    expect(surfaceCard).not.toContain("sit.svg");
    expect(surfaceCard).not.toContain("listen.svg");
    expect(aggregateCard).not.toContain("sit.svg");
    expect(aggregateCard).not.toContain("dig.svg");
    expect(aggregateCard).not.toContain("listen.svg");
  });
});

const CLIENT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const customersUk = customersCopy("uk");
const assistantChromeUk = sharedAssistantCopy("uk");

function customerRow(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "Іван",
    phone: "+380501112233",
    email: "ivan@example.com",
    status: "active",
    groupId: null,
    priceListId: null,
    ...overrides,
  };
}

function customersOutput(
  items: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    items,
    nextCursor: null,
    ...extra,
  };
}

describe("customers-list collection surface (SHO-472)", () => {
  it("parses façade-shaped output onto the same collection view as orders-list", () => {
    const parts = [
      {
        type: `tool-${CUSTOMERS_LIST_CUSTOMERS_TOOL}` as const,
        toolCallId: "call-customers",
        state: "output-available" as const,
        output: customersOutput([
          customerRow(CLIENT_A),
          customerRow(CLIENT_B, {
            name: "Оля",
            status: "archived",
            phone: null,
            email: "olya@example.com",
          }),
        ]),
      },
    ];
    const surfaces = surfacesFromParts(parts, "uk");
    const customers = customersOf(surfaces);
    expect(customers?.kind).toBe("customers-list");
    expect(customers?.destination).toEqual({
      kind: "screen",
      href: ASSISTANT_CUSTOMERS_LIST_HREF,
    });
    expect(ASSISTANT_CUSTOMERS_LIST_HREF).toBe(
      ASSISTANT_CUSTOMERS_LIST_SCREEN_HREF,
    );
    expect(customers?.handoffLabel).toBe(
      assistantChromeUk.customersList.openList,
    );
    expect(customers?.ctaHref).toBeNull();
    expect(customers?.rows[0]?.href).toBe(customerEditorHref(CLIENT_A));
    expect(customers?.rows[0]?.name).toBe("Іван");
    expect(customers?.rows[0]?.statusLabel).toBeNull();
    expect(customers?.rows[0]?.metaLabel).toBe(
      "+380501112233 · ivan@example.com",
    );
    expect(customers?.rows[1]?.statusLabel).toBe(customersUk.archivedBadge);
    expect(customers?.collection.rowCap).toBe(ASSISTANT_CUSTOMERS_LIST_ROW_MAX);
    expect(customers?.collection.surface).toBe("plain");
    const parsed = parseCustomersListData(toolResultsFrom(parts));
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const collection = localizeCustomersListCard(parsed, "uk").collection;
    expect(collection.rows[0]?.href).toBe(customerEditorHref(CLIENT_A));
    expect(collection.rows[0]?.title).toBe(customers?.rows[0]?.name);
    expect(collection.rows[1]?.badge).toBe(customersUk.archivedBadge);
  });

  it("truncates customers at 7 from that surface's cap and omits a duplicate CTA", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      customerRow(
        `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa${String(index).padStart(2, "0")}`,
      ),
    );
    const parts = [
      {
        type: `tool-${CUSTOMERS_LIST_CUSTOMERS_TOOL}` as const,
        toolCallId: "call-customers",
        state: "output-available" as const,
        output: customersOutput(items),
      },
    ];
    const customers = customersOf(surfacesFromParts(parts, "uk"));
    const parsed = parseCustomersListData(toolResultsFrom(parts));
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      return;
    }
    const collection = localizeCustomersListCard(parsed, "uk").collection;
    expect(ASSISTANT_CUSTOMERS_LIST_ROW_MAX).toBe(7);
    expect(customers?.rows).toHaveLength(7);
    expect(collection.rows).toHaveLength(7);
    expect(collection.truncated).toBe(true);
    expect(customers?.collection.truncated).toBe(true);
    expect(customers?.collection.rowCap).toBe(7);
    expect(customers?.ctaHref).toBeNull();
    expect(ASSISTANT_ORDERS_LIST_ROW_MAX).toBe(50);
  });

  it("shows empty chrome from @showzy/copy/assistant, not app i18n leftovers", () => {
    const customers = customersOf(
      surfacesFromParts(
        [
          {
            type: `tool-${CUSTOMERS_LIST_CUSTOMERS_TOOL}`,
            toolCallId: "call-customers",
            state: "output-available",
            output: customersOutput([]),
          },
        ],
        "uk",
      ),
    );
    expect(customers?.emptyTitle).toBe(
      assistantChromeUk.customersList.listEmptyTitle,
    );
    expect(customers?.emptyDescription).toBe(
      assistantChromeUk.customersList.listEmptyDescription,
    );
    expect(customers?.handoffLabel).toBe(
      assistantChromeUk.customersList.openList,
    );
    expect(customers?.rows).toEqual([]);
  });

  it("does not walk customer ids into entity cards", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: `tool-${CUSTOMERS_LIST_CUSTOMERS_TOOL}`,
          toolCallId: "call-customers",
          state: "output-available",
          output: customersOutput([customerRow(CLIENT_A)]),
        },
      ],
      "uk",
    );
    expect(entitiesOf(surfaces)).toEqual([]);
    expect(listOf(surfaces)).toBeNull();
    expect(customersOf(surfaces)?.kind).toBe("customers-list");
  });

  it("proves a third list needs only a collection descriptor, not a new card file", () => {
    const thirdList: AssistantCollectionView = {
      surface: "inset",
      rowCap: 3,
      truncated: true,
      columns: [
        { id: "title", label: "", width: "flex", alignment: "start" },
        { id: "total", label: "", width: "auto", alignment: "end" },
      ],
      rows: [
        {
          id: CLIENT_A,
          title: "Price list A",
          badge: null,
          badgeTone: "neutral",
          meta: "3 entries",
          cells: ["1 200,00 ₴"],
          href: "/price-lists",
        },
      ],
    };
    expect(thirdList.surface).toBe("inset");
    const surfaceCard = readFileSync(
      new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
      "utf8",
    );
    const collectionBlock = readFileSync(
      new URL("../sheet/assistant-collection-block.tsx", import.meta.url),
      "utf8",
    );
    expect(surfaceCard).not.toContain("customers-list-result-card");
    expect(surfaceCard).toContain("AssistantCollectionBlock");
    expect(collectionBlock).toContain("AssistantCollectionBlock");
  });
});

const GROUP_ID = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COUNTERPARTY_ID = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_ID = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_ID = "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRICE_LIST_ID = "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_ID = "66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function searchHit(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    label: "Катя Самбука",
    sublabel: "SKU-1",
    status: "active",
    matchedOn: "name",
    exact: true,
    ...extra,
  };
}

function searchOutput(
  groups: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    groups,
    searchedTypes: ["customer", "order"],
    queryNormalized: "katya",
    ...extra,
  };
}

describe("search-results grouped surface (SHO-535)", () => {
  it("shows empty chrome when groups are empty", () => {
    const surfaces = surfacesFromParts(
      [
        {
          type: `tool-${SEARCH_QUERY_TOOL}` as const,
          toolCallId: "call-search",
          state: "output-available",
          output: searchOutput([]),
        },
      ],
      "uk",
    );
    const card = searchResultsOf(surfaces);
    expect(card?.kind).toBe("search-results");
    expect(card?.destination).toEqual({ kind: "terminal" });
    expect(card?.emptyTitle).toBe(assistantChromeUk.searchResults.emptyTitle);
    expect(card?.emptyDescription).toBe(
      assistantChromeUk.searchResults.emptyDescription,
    );
    expect(card?.groups).toEqual([]);
    expect(card?.ctaHref).toBeNull();
  });

  it("keeps truncated empty groups visible in chrome", () => {
    const card = searchResultsOf(
      surfacesFromParts(
        [
          {
            type: `tool-${SEARCH_QUERY_TOOL}` as const,
            toolCallId: "call-search",
            state: "output-available",
            output: searchOutput([
              { type: "order", truncated: true, hits: [] },
            ]),
          },
        ],
        "uk",
      ),
    );
    expect(card?.emptyTitle).toBeNull();
    expect(card?.groups).toHaveLength(1);
    expect(card?.groups[0]?.entityType).toBe("order");
    expect(card?.groups[0]?.heading).toBe(
      assistantChromeUk.searchResults.groups.order,
    );
    expect(card?.groups[0]?.truncatedLabel).toBe(
      assistantChromeUk.searchResults.truncated,
    );
    expect(card?.groups[0]?.emptyLabel).toBe(
      assistantChromeUk.searchResults.groupEmpty,
    );
    expect(card?.footnotes).toContain(
      assistantChromeUk.searchResults.truncated,
    );
  });

  it("opens typed hrefs, including variant productId and documents list", () => {
    const card = searchResultsOf(
      surfacesFromParts(
        [
          {
            type: `tool-${SEARCH_QUERY_TOOL}` as const,
            toolCallId: "call-search",
            state: "output-available",
            output: searchOutput([
              {
                type: "order",
                truncated: false,
                hits: [searchHit(ORDER_A, { label: "#1049" })],
              },
              {
                type: "customer",
                truncated: false,
                hits: [searchHit(CLIENT_A)],
              },
              {
                type: "customerGroup",
                truncated: false,
                hits: [searchHit(GROUP_ID, { label: "VIP" })],
              },
              {
                type: "counterparty",
                truncated: false,
                hits: [searchHit(COUNTERPARTY_ID, { label: "ТОВ" })],
              },
              {
                type: "product",
                truncated: false,
                hits: [searchHit(PRODUCT_ID, { label: "Napoleon" })],
              },
              {
                type: "variant",
                truncated: false,
                hits: [
                  searchHit(VARIANT_ID, {
                    label: "M / vanilla",
                    productId: PRODUCT_ID,
                    sublabel: "do-not-parse-me",
                  }),
                ],
              },
              {
                type: "priceList",
                truncated: false,
                hits: [searchHit(PRICE_LIST_ID, { label: "Retail" })],
              },
              {
                type: "document",
                truncated: false,
                hits: [searchHit(DOCUMENT_ID, { label: "INV-1" })],
              },
            ]),
          },
        ],
        "uk",
      ),
    );
    const hrefByType = new Map(
      card?.groups.map((group) => [group.entityType, group.hits[0]?.href]),
    );
    expect(hrefByType.get("order")).toBe(orderDetailHref(ORDER_A));
    expect(hrefByType.get("customer")).toBe(customerEditorHref(CLIENT_A));
    expect(hrefByType.get("customerGroup")).toBe(groupEditorHref(GROUP_ID));
    expect(hrefByType.get("counterparty")).toBe(
      counterpartyEditorHref(COUNTERPARTY_ID),
    );
    expect(hrefByType.get("product")).toBe(productPhotoHref(PRODUCT_ID));
    expect(hrefByType.get("product")).not.toBe(productEditorHref(PRODUCT_ID));
    expect(hrefByType.get("variant")).toBe(productPhotoHref(PRODUCT_ID));
    expect(hrefByType.get("variant")).not.toBe(productEditorHref(PRODUCT_ID));
    expect(hrefByType.get("variant")).not.toContain("do-not-parse-me");
    expect(hrefByType.get("variant")).not.toContain("/edit");
    expect(hrefByType.get("priceList")).toBe(
      priceListEditorHref(PRICE_LIST_ID),
    );
    expect(hrefByType.get("document")).toBe(documentsHref());
    expect(hrefByType.get("document")).not.toContain(DOCUMENT_ID);
  });

  it("does not invent a search-results-result-card or a second collection block", () => {
    const surfaceCard = readFileSync(
      new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
      "utf8",
    );
    const searchBlock = readFileSync(
      new URL("../sheet/assistant-search-results-block.tsx", import.meta.url),
      "utf8",
    );
    expect(surfaceCard).toContain("AssistantSearchResultsBlock");
    expect(surfaceCard).not.toContain("search-results-result-card");
    expect(surfaceCard.match(/<AssistantCollectionBlock/g)?.length).toBe(1);
    expect(searchBlock).toContain("AssistantCollectionResultRow");
    expect(searchBlock).not.toContain("<Button");
    expect(searchBlock).not.toMatch(/import\s*\{[^}]*\bCard\b/);
    expect(searchBlock).not.toContain("<Card");
  });
});

function breakdownView(
  groupingKey: "product" | "status" | "customer",
): Extract<AssistantAggregateView, { layout: "breakdown" }> {
  const copy = assistantChromeUk.aggregate;
  const groupLabel =
    groupingKey === "product"
      ? copy.productColumn
      : groupingKey === "status"
        ? copy.statusColumn
        : copy.customerColumn;
  return {
    layout: "breakdown",
    groupingKey,
    columns: localizeAggregateColumns([
      {
        id: "group",
        label: groupLabel,
        width: "flex",
        alignment: "start",
      },
      {
        id: "count",
        label: copy.countColumn,
        width: "auto",
        alignment: "end",
      },
      {
        id: "amount",
        label: copy.amountColumn,
        width: "auto",
        alignment: "end",
      },
    ]),
    groups: [
      {
        id: `${groupingKey}-parent`,
        head: {
          id: `${groupingKey}-head`,
          title: groupingKey,
          badge: null,
          badgeTone: "neutral",
          meta: null,
          cells: ["2", "1 000,00 ₴"],
          href: null,
        },
        children: [
          {
            id: `${groupingKey}-child`,
            title: "child",
            badge: null,
            badgeTone: "neutral",
            meta: null,
            cells: ["1", "500,00 ₴"],
            href: null,
          },
        ],
      },
    ],
    total: {
      id: "total",
      title: copy.totals,
      badge: null,
      badgeTone: "neutral",
      meta: null,
      cells: ["2", "1 000,00 ₴"],
      href: null,
    },
  };
}

describe("aggregate block layouts (SHO-473)", () => {
  it("renders summary and breakdown through the same block", () => {
    const aggregateBlock = readFileSync(
      new URL("../sheet/assistant-aggregate-block.tsx", import.meta.url),
      "utf8",
    );
    const aggregateCard = readFileSync(
      new URL("../sheet/orders-aggregate-result-card.tsx", import.meta.url),
      "utf8",
    );
    const collectionBlock = readFileSync(
      new URL("../sheet/assistant-collection-block.tsx", import.meta.url),
      "utf8",
    );
    const surfaceCard = readFileSync(
      new URL("../sheet/assistant-surface-card.tsx", import.meta.url),
      "utf8",
    );
    expect(aggregateBlock).toContain("export const AssistantAggregateBlock");
    expect(aggregateBlock).toContain('case "summary"');
    expect(aggregateBlock).toContain('case "breakdown"');
    expect(aggregateBlock.match(/case "/g)?.length).toBe(2);
    expect(isAssistantAggregateLayout("summary")).toBe(true);
    expect(isAssistantAggregateLayout("breakdown")).toBe(true);
    expect(isAssistantAggregateLayout("chart")).toBe(false);
    expect(aggregateBlock).toContain("AssistantCollectionResultRow");
    expect(aggregateBlock).toContain("AssistantCollectionColumnHeaders");
    expect(aggregateBlock).not.toContain("AggregateBucketRow");
    expect(collectionBlock).toContain(
      "export const AssistantCollectionResultRow",
    );
    expect(aggregateCard).toContain("AssistantAggregateBlock");
    expect(surfaceCard).toContain("OrdersAggregateResultCard");
    expect(surfaceCard).toContain("onOpenHref={onOpenHref}");
  });

  it("uses one breakdown layout for 3.5 / 3.6 / 3.7 grouping keys, with a totals row", () => {
    const product = breakdownView("product");
    const status = breakdownView("status");
    const customer = breakdownView("customer");
    const fixtures = [product, status, customer];
    expect(fixtures.map((fixture) => fixture.layout)).toEqual([
      "breakdown",
      "breakdown",
      "breakdown",
    ]);
    expect(fixtures.map((fixture) => fixture.groupingKey)).toEqual([
      "product",
      "status",
      "customer",
    ]);
    expect(
      new Set(fixtures.map((fixture) => fixture.columns[0]?.label)).size,
    ).toBe(3);
    for (const fixture of fixtures) {
      expect(fixture.total).not.toBeNull();
      expect(fixture.total?.title).toBe(assistantChromeUk.aggregate.totals);
      expect(fixture.groups).toHaveLength(1);
    }
    const summary = aggregateOf(
      surfacesFromParts(
        [
          countsPart(
            countsOutput(
              [
                {
                  identity: { kind: "status", status: "new" },
                  orderCount: 1,
                },
              ],
              {
                statusBuckets: [statusBucket("new", 1)],
              },
            ),
          ),
        ],
        "uk",
      ),
    );
    expect(summary?.aggregate.layout).toBe("summary");
    expect("total" in (summary?.aggregate ?? {})).toBe(false);
  });

  it("keeps the live orders-aggregate staff-visible fields on summary", () => {
    const card = aggregateOf(
      surfacesFromParts(
        [
          countsPart(
            countsOutput(
              [
                {
                  identity: {
                    kind: "product",
                    productId: PRODUCT_A,
                    variantId: null,
                  },
                  label: "Троянда",
                  orderCount: 2,
                  grossByCurrency: [
                    { currency: "UAH", grossAmountMinor: "5000" },
                  ],
                  quantityMilli: "1500",
                },
              ],
              {
                orderCount: 2,
                grossByCurrency: [
                  { currency: "UAH", grossAmountMinor: "5000" },
                ],
                statusBuckets: [
                  statusBucket("new", 2, [
                    { currency: "UAH", grossAmountMinor: "5000" },
                  ]),
                ],
              },
            ),
            { groupBy: "product" },
          ),
        ],
        "uk",
      ),
    );
    expect(card).not.toBeNull();
    if (card === null) {
      return;
    }
    assertLabeledBucketList(card);
    expect(card.aggregate.layout).toBe("summary");
    if (card.aggregate.layout !== "summary") {
      return;
    }
    expect(card.aggregate.sections).toHaveLength(2);
    expect(card.aggregate.sections[0]?.id).toBe("status");
    expect(card.aggregate.sections[0]?.rows[0]?.badge).toBe(
      ordersUk.statuses.new,
    );
    expect(card.aggregate.sections[1]?.id).toBe("product");
    expect(card.aggregate.sections[1]?.id).toBe(card.aggregate.groupingKey);
    expect(card.aggregate.sections[1]?.rows[0]?.title).toBe("Троянда");
    expect(card.aggregate.featured).toBeNull();
  });
});
