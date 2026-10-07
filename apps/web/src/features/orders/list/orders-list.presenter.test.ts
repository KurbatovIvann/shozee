import { UNLINKED_CUSTOMER_NAME_SNAPSHOT } from "@showzy/contract";
import { describe, expect, it } from "vitest";

import { ordersCopy } from "../../../i18n/orders";
import type { OrderListItem } from "../api/list";
import { localizeCustomerNameSnapshot } from "../shared/customer-name";
import {
  classifyOrdersList,
  formatOrderCreatedAt,
  groupOrderRows,
  toOrderRowView,
} from "./orders-list.presenter";

const COPY = ordersCopy("uk");

function row(
  overrides: Partial<OrderListItem> & Pick<OrderListItem, "orderId" | "status">,
): OrderListItem {
  return {
    orderNumber: "KL-K7K3K4",
    customer: { nameSnapshot: "Анна", linkedCustomerId: null },
    itemCount: 2,
    totalGrossMinor: "150000",
    currency: "UAH",
    createdAt: "2026-03-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("orders list presenter (SHO-377)", () => {
  it("localizes the unlinked snapshot sentinel", () => {
    expect(UNLINKED_CUSTOMER_NAME_SNAPSHOT).toBe("unlinked");
    expect(
      localizeCustomerNameSnapshot(
        UNLINKED_CUSTOMER_NAME_SNAPSHOT,
        COPY.missingCustomer,
      ),
    ).toBe("Клієнт видалений");
    expect(localizeCustomerNameSnapshot("Анна", COPY.missingCustomer)).toBe(
      "Анна",
    );
  });

  it("formats an absolute created date, not a relative щойно", () => {
    const label = formatOrderCreatedAt("2026-03-15T12:00:00.000Z", "uk");
    expect(label).toContain("2026");
    expect(label).not.toBe("щойно");
    expect(label).toMatch(/бер\./);
  });

  it("shows #PREFIX-TOKEN, item count, status tone, and money from wire", () => {
    const view = toOrderRowView(
      row({
        orderId: "11111111-1111-4111-8111-111111111111",
        status: "confirmed",
      }),
      { locale: "uk", copy: COPY },
    );
    expect(view.orderNumberLabel).toBe("#KL-K7K3K4");
    expect(view.metaLabel).toContain("#KL-K7K3K4");
    expect(view.metaLabel).toContain("2 позиції");
    expect(view.metaLabel).not.toMatch(/^#\d+$/);
    expect(view.statusTone).toBe("focus");
    expect(view.statusLabel).toBe("Підтверджено");
    expect(view.totalLabel).toContain("₴");
  });

  it("groups Активні / Закриті from status membership, even for one chip", () => {
    const views = [
      toOrderRowView(
        row({
          orderId: "11111111-1111-4111-8111-111111111111",
          status: "in_progress",
        }),
        { locale: "uk", copy: COPY },
      ),
      toOrderRowView(
        row({
          orderId: "22222222-2222-4222-8222-222222222222",
          status: "done",
          orderNumber: "KL-DONE01",
        }),
        { locale: "uk", copy: COPY },
      ),
    ];
    const grouped = groupOrderRows(views);
    const headers = grouped.filter((entry) => entry.type === "header");
    expect(headers).toEqual([
      { type: "header", key: "active", count: 1 },
      { type: "header", key: "closed", count: 1 },
    ]);
    expect(headers.map((entry) => entry.key)).toEqual(["active", "closed"]);
    expect(JSON.stringify(headers)).not.toContain("В роботі");
    expect(JSON.stringify(headers)).not.toContain("Завершені");
  });

  it("classifies loading, catalog-empty, and filtered-empty", () => {
    expect(
      classifyOrdersList({
        status: "pending",
        rowCount: 0,
        hasStatusFilter: false,
        hasSearch: false,
      }).kind,
    ).toBe("loading");
    expect(
      classifyOrdersList({
        status: "success",
        rowCount: 0,
        hasStatusFilter: false,
        hasSearch: false,
      }).kind,
    ).toBe("empty-catalog");
    expect(
      classifyOrdersList({
        status: "success",
        rowCount: 0,
        hasStatusFilter: true,
        hasSearch: false,
      }).kind,
    ).toBe("empty-filtered");
    expect(
      classifyOrdersList({
        status: "success",
        rowCount: 0,
        hasStatusFilter: false,
        hasSearch: true,
      }).kind,
    ).toBe("empty-filtered");
  });
});
