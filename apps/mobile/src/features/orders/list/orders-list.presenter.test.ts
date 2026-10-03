import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import type { OrderListItem } from "../api/order.queries";
import { LIST_ORDERS_QUERY_MAX as capsQueryMax } from "../shared/order-caps";
import {
  classifyOrdersList,
  flattenOrderPages,
  formatOrderCreatedAt,
  groupOrderRows,
  hasActiveStatusFilter,
  isClosedOrderStatus,
  isOpenOrderStatus,
  listOrdersPageInput,
  localizeCustomerNameSnapshot,
  normalizeOrdersSearch,
  orderGroupHeaderLabel,
  orderListGroupEdge,
  orderStatusTone,
  stickyHeaderIndices,
  toggleOrderStatusFilter,
  toOrderRowView,
  LIST_ORDERS_QUERY_MAX,
  ORDER_STATUS_FILTERS,
  UNLINKED_CUSTOMER_NAME_SNAPSHOT,
  type OrderRowView,
} from "./orders-list.presenter";

const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const ORDER_NEW = "0f0e2d5c-4a1b-4c3d-9e8f-102938475601";
const ORDER_CONFIRMED = "1f0e2d5c-4a1b-4c3d-9e8f-102938475602";
const ORDER_CANCELED = "2f0e2d5c-4a1b-4c3d-9e8f-102938475603";
const ORDER_IN_PROGRESS = "3f0e2d5c-4a1b-4c3d-9e8f-102938475604";
const ORDER_DONE = "4f0e2d5c-4a1b-4c3d-9e8f-102938475605";

function item(overrides: Partial<OrderListItem> = {}): OrderListItem {
  return {
    orderId: ORDER_NEW,
    orderNumber: "KA-1",
    customer: {
      nameSnapshot: "Марія Ткаченко",
      linkedCustomerId: CUSTOMER_A,
    },
    status: "new",
    itemCount: 2,
    totalGrossMinor: "125000",
    currency: "UAH",
    createdAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<OrderRowView> = {}): OrderRowView {
  return {
    id: ORDER_NEW,
    customerName: "Марія Ткаченко",
    customerNamePending: false,
    status: "new",
    statusLabel: "Нове",
    statusTone: "action",
    metaLabel: "2 позиції · 25 серп. 2026",
    totalLabel: "1 250 ₴",
    ...overrides,
  };
}

describe("toggleOrderStatusFilter", () => {
  it("pins five CHECK chips and never uses active/all/completed as wire values", () => {
    expect(ORDER_STATUS_FILTERS).toEqual([
      "new",
      "confirmed",
      "in_progress",
      "done",
      "canceled",
    ]);
    expect(ORDER_STATUS_FILTERS).not.toContain("active");
    expect(ORDER_STATUS_FILTERS).not.toContain("all");
    expect(ORDER_STATUS_FILTERS).not.toContain("completed");
  });

  it("adds, removes, and keeps canonical CHECK order", () => {
    expect(toggleOrderStatusFilter([], "confirmed")).toEqual(["confirmed"]);
    expect(toggleOrderStatusFilter(["confirmed"], "new")).toEqual([
      "new",
      "confirmed",
    ]);
    expect(
      toggleOrderStatusFilter(["new", "confirmed", "canceled"], "confirmed"),
    ).toEqual(["new", "canceled"]);
    expect(toggleOrderStatusFilter(["done", "new"], "in_progress")).toEqual([
      "new",
      "in_progress",
      "done",
    ]);
    expect(
      toggleOrderStatusFilter(["canceled", "done"], "in_progress"),
    ).toEqual(["in_progress", "done", "canceled"]);
  });
});

describe("normalizeOrdersSearch", () => {
  it("treats empty and whitespace-only input as no search", () => {
    expect(normalizeOrdersSearch("")).toBeUndefined();
    expect(normalizeOrdersSearch("   ")).toBeUndefined();
  });

  it("trims and caps at the orders.list query max, not a local literal", () => {
    expect(LIST_ORDERS_QUERY_MAX).toBe(capsQueryMax);
    expect(LIST_ORDERS_QUERY_MAX).toBe(100);
    expect(normalizeOrdersSearch("  1042  ")).toBe("1042");
    const long = "a".repeat(LIST_ORDERS_QUERY_MAX + 20);
    expect(normalizeOrdersSearch(long)).toHaveLength(LIST_ORDERS_QUERY_MAX);
  });
});

describe("listOrdersPageInput", () => {
  it("omits statuses when no chips are selected", () => {
    expect(listOrdersPageInput([], undefined)).toEqual({
      kind: "page.summary",
    });
    expect(hasActiveStatusFilter([])).toBe(false);
  });

  it("sends selected statuses to the server, including multi-select", () => {
    expect(listOrdersPageInput(["canceled"], undefined)).toEqual({
      kind: "page.summary",
      filter: { statuses: ["canceled"] },
    });
    expect(
      listOrdersPageInput(["new", "in_progress", "done"], undefined),
    ).toEqual({
      kind: "page.summary",
      filter: { statuses: ["new", "in_progress", "done"] },
    });
    expect(
      listOrdersPageInput(
        ["new", "confirmed", "in_progress", "done", "canceled"],
        undefined,
      ),
    ).toEqual({
      kind: "page.summary",
      filter: {
        statuses: ["new", "confirmed", "in_progress", "done", "canceled"],
      },
    });
    expect(hasActiveStatusFilter(["new"])).toBe(true);
    expect(hasActiveStatusFilter(["in_progress"])).toBe(true);
  });

  it("omits the query key entirely when there is no search", () => {
    expect(listOrdersPageInput([], undefined)).toEqual({
      kind: "page.summary",
    });
    expect(listOrdersPageInput(["canceled"], "1042")).toEqual({
      kind: "page.summary",
      filter: { statuses: ["canceled"], query: "1042" },
    });
    expect(listOrdersPageInput([], "1042")).toEqual({
      kind: "page.summary",
      filter: { query: "1042" },
    });
  });
});

describe("flattenOrderPages", () => {
  it("concatenates page items in order", () => {
    const first = item({ orderId: ORDER_NEW });
    const second = item({ orderId: ORDER_CONFIRMED });
    const third = item({ orderId: ORDER_CANCELED });
    expect(
      flattenOrderPages([{ items: [first, second] }, { items: [third] }]),
    ).toEqual([first, second, third]);
  });
});

describe("localizeCustomerNameSnapshot", () => {
  it("localizes the unlinked sentinel in the presenter, not as persisted English copy", () => {
    const copy = ordersCopy("en");
    expect(UNLINKED_CUSTOMER_NAME_SNAPSHOT).toBe("unlinked");
    expect(
      localizeCustomerNameSnapshot(
        UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        copy.missingCustomer,
      ),
    ).toBe("Deleted customer");
    expect(
      localizeCustomerNameSnapshot(
        UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        ordersCopy("uk").missingCustomer,
      ),
    ).toBe("Клієнт видалений");
    expect(
      localizeCustomerNameSnapshot("Марія Ткаченко", copy.missingCustomer),
    ).toBe("Марія Ткаченко");
  });
});

describe("toOrderRowView", () => {
  it("maps a contract row onto primitives with snapshot name and #number", () => {
    const copy = ordersCopy("uk");
    const view = toOrderRowView(
      item({
        orderNumber: "KA-K7X2",
        customer: {
          nameSnapshot: UNLINKED_CUSTOMER_NAME_SNAPSHOT,
          linkedCustomerId: CUSTOMER_B,
        },
        status: "canceled",
        itemCount: 1,
        totalGrossMinor: "89000",
      }),
      { locale: "uk", copy },
    );
    expect(view.customerName).toBe(copy.missingCustomer);
    expect(view.customerNamePending).toBe(false);
    expect(view.status).toBe("canceled");
    expect(view.statusLabel).toBe("Скасовано");
    expect(view.statusTone).toBe("danger");
    expect(view.metaLabel).toBe("#KA-K7X2 · 1 позиція · 25 серп. 2026");
    expect(view.totalLabel).toBe("890\u00A0₴");
    expect(JSON.stringify(view)).not.toContain("SHZ-");
    expect(JSON.stringify(view)).not.toContain("Оплачен");
    expect(JSON.stringify(view)).not.toContain("unlinked");
  });

  it("maps in_progress and done pills from CHECK statuses", () => {
    const copy = ordersCopy("uk");
    const inProgress = toOrderRowView(item({ status: "in_progress" }), {
      locale: "uk",
      copy,
    });
    expect(inProgress.statusLabel).toBe("В роботі");
    expect(inProgress.statusTone).toBe("attention");
    const done = toOrderRowView(item({ status: "done" }), {
      locale: "uk",
      copy,
    });
    expect(done.statusLabel).toBe("Виконано");
    expect(done.statusTone).toBe("success");
  });

  it("keeps a live snapshot name without a getCustomer round-trip", () => {
    const view = toOrderRowView(item(), {
      locale: "uk",
      copy: ordersCopy("uk"),
    });
    expect(view.customerName).toBe("Марія Ткаченко");
    expect(view.customerNamePending).toBe(false);
    expect(view.statusTone).toBe("action");
  });
});

describe("formatOrderCreatedAt", () => {
  it("formats the canvas d MMM yyyy date in uk and en", () => {
    expect(formatOrderCreatedAt("2026-08-25T12:00:00.000Z", "uk")).toBe(
      "25 серп. 2026",
    );
    expect(formatOrderCreatedAt("2026-08-25T12:00:00.000Z", "en")).toBe(
      "25 Aug 2026",
    );
  });
});

describe("orderStatusTone / open vs closed", () => {
  it("maps each CHECK status onto the chrome tone", () => {
    expect(orderStatusTone("new")).toBe("action");
    expect(orderStatusTone("confirmed")).toBe("focus");
    expect(orderStatusTone("in_progress")).toBe("attention");
    expect(orderStatusTone("done")).toBe("success");
    expect(orderStatusTone("canceled")).toBe("danger");
  });

  it("treats new+confirmed+in_progress as active and done+canceled as closed", () => {
    expect(isOpenOrderStatus("new")).toBe(true);
    expect(isOpenOrderStatus("confirmed")).toBe(true);
    expect(isOpenOrderStatus("in_progress")).toBe(true);
    expect(isOpenOrderStatus("done")).toBe(false);
    expect(isOpenOrderStatus("canceled")).toBe(false);
    expect(isClosedOrderStatus("done")).toBe(true);
    expect(isClosedOrderStatus("canceled")).toBe(true);
    expect(isClosedOrderStatus("in_progress")).toBe(false);
  });
});

describe("groupOrderRows", () => {
  it("groups active (new+confirmed+in_progress) then closed (done+canceled)", () => {
    const entries = groupOrderRows([
      row({ id: ORDER_NEW, status: "new" }),
      row({
        id: ORDER_CANCELED,
        status: "canceled",
        statusTone: "danger",
      }),
      row({
        id: ORDER_IN_PROGRESS,
        status: "in_progress",
        statusTone: "attention",
      }),
      row({
        id: ORDER_DONE,
        status: "done",
        statusTone: "success",
      }),
      row({
        id: ORDER_CONFIRMED,
        status: "confirmed",
        statusTone: "focus",
      }),
    ]);
    expect(entries.map((entry) => entry.type)).toEqual([
      "header",
      "row",
      "row",
      "row",
      "header",
      "row",
      "row",
    ]);
    expect(entries[0]).toEqual({
      type: "header",
      key: "active",
      count: 3,
    });
    expect(entries[1]?.type === "row" ? entries[1].order.id : null).toBe(
      ORDER_NEW,
    );
    expect(entries[2]?.type === "row" ? entries[2].order.id : null).toBe(
      ORDER_IN_PROGRESS,
    );
    expect(entries[3]?.type === "row" ? entries[3].order.id : null).toBe(
      ORDER_CONFIRMED,
    );
    expect(entries[4]).toEqual({
      type: "header",
      key: "closed",
      count: 2,
    });
    expect(entries[5]?.type === "row" ? entries[5].order.id : null).toBe(
      ORDER_CANCELED,
    );
    expect(entries[6]?.type === "row" ? entries[6].order.id : null).toBe(
      ORDER_DONE,
    );
    expect(stickyHeaderIndices(entries)).toEqual([0, 4]);
  });

  it("omits an empty group", () => {
    expect(
      groupOrderRows([row({ id: ORDER_CANCELED, status: "canceled" })]),
    ).toEqual([
      { type: "header", key: "closed", count: 1 },
      {
        type: "row",
        order: row({ id: ORDER_CANCELED, status: "canceled" }),
      },
    ]);
  });

  it("splits ListSurface chrome per sticky group without wrapping headers", () => {
    const entries = groupOrderRows([
      row({ id: ORDER_NEW, status: "new" }),
      row({
        id: ORDER_CONFIRMED,
        status: "confirmed",
        statusTone: "focus",
      }),
      row({ id: ORDER_CANCELED, status: "canceled", statusTone: "danger" }),
    ]);
    expect(orderListGroupEdge(entries, 0)).toBeNull();
    expect(orderListGroupEdge(entries, 1)).toBe("start");
    expect(orderListGroupEdge(entries, 2)).toBe("end");
    expect(orderListGroupEdge(entries, 3)).toBeNull();
    expect(orderListGroupEdge(entries, 4)).toBe("only");
    expect(
      orderListGroupEdge(
        groupOrderRows([row({ id: ORDER_NEW, status: "new" })]),
        1,
      ),
    ).toBe("only");
  });
});

describe("orderGroupHeaderLabel", () => {
  it("interpolates Активні / Закриті, never В роботі / Завершені as group titles", () => {
    expect(orderGroupHeaderLabel("active", 3, ordersCopy("uk"))).toBe(
      "Активні · 3",
    );
    expect(orderGroupHeaderLabel("closed", 1, ordersCopy("uk"))).toBe(
      "Закриті · 1",
    );
    expect(orderGroupHeaderLabel("closed", 1, ordersCopy("en"))).toBe(
      "Closed · 1",
    );
    expect(orderGroupHeaderLabel("active", 2, ordersCopy("en"))).toBe(
      "Active · 2",
    );
    expect(orderGroupHeaderLabel("active", 1, ordersCopy("uk"))).not.toContain(
      "В роботі",
    );
    expect(orderGroupHeaderLabel("closed", 1, ordersCopy("uk"))).not.toContain(
      "Завершені",
    );
    expect(ordersCopy("uk").groups.active).not.toBe(
      ordersCopy("uk").statuses.in_progress,
    );
    expect(ordersCopy("uk").groups.closed).not.toBe(
      ordersCopy("uk").statuses.done,
    );
  });
});

describe("classifyOrdersList", () => {
  const base = {
    clientReady: true,
    status: "success" as const,
    failureKind: null,
    rowCount: 0,
    hasStatusFilter: false,
    hasSearch: false,
    hasNextPage: false,
    isFetchingNextPage: false,
  };

  it("is an error when the client is not ready", () => {
    expect(classifyOrdersList({ ...base, clientReady: false })).toEqual({
      kind: "error",
    });
  });

  it("is loading while the list query is pending", () => {
    expect(classifyOrdersList({ ...base, status: "pending" })).toEqual({
      kind: "loading",
    });
  });

  it("splits offline from other failures", () => {
    expect(
      classifyOrdersList({
        ...base,
        status: "error",
        failureKind: "offline",
      }),
    ).toEqual({ kind: "offline" });
    expect(
      classifyOrdersList({
        ...base,
        status: "error",
        failureKind: "network",
      }),
    ).toEqual({ kind: "error" });
  });

  it("shows rows whenever any are loaded", () => {
    expect(classifyOrdersList({ ...base, rowCount: 2 })).toEqual({
      kind: "rows",
    });
  });

  it("tells catalog-empty apart from filtered-empty", () => {
    expect(classifyOrdersList(base)).toEqual({ kind: "empty-catalog" });
    expect(classifyOrdersList({ ...base, hasStatusFilter: true })).toEqual({
      kind: "empty-filtered",
    });
    expect(
      classifyOrdersList({ ...base, rowCount: 1, hasStatusFilter: true }),
    ).toEqual({ kind: "rows" });
  });

  it("classifies search empty vs match without a new empty kind", () => {
    expect(classifyOrdersList({ ...base, hasSearch: true })).toEqual({
      kind: "empty-filtered",
    });
    expect(
      classifyOrdersList({ ...base, hasSearch: true, rowCount: 2 }),
    ).toEqual({ kind: "rows" });
    expect(
      classifyOrdersList({
        ...base,
        hasSearch: true,
        hasStatusFilter: true,
      }),
    ).toEqual({ kind: "empty-filtered" });
  });

  it("treats a server status filter with no matches as filtered-empty", () => {
    expect(
      classifyOrdersList({
        ...base,
        hasStatusFilter: true,
        hasNextPage: true,
      }),
    ).toEqual({ kind: "empty-filtered" });
  });
});
