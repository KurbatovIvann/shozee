/**
 * Pure view-model logic for the web orders list (SHO-377). No React
 * so the decision surface is unit-testable.
 */
import { interpolate, type Locale } from "../../../i18n/locale";
import type { OrdersCopy } from "../../../i18n/orders";
import { countPluralForm } from "../../../i18n/plural";
import type { OrderListItem } from "../api/list";
import { localizeCustomerNameSnapshot } from "../shared/customer-name";
import { formatOrderMoney } from "../shared/format-order-money";
import {
  isClosedOrderStatus,
  isOpenOrderStatus,
  orderStatusTone,
  type OrderLifecycleStatus,
  type OrderStatusTone,
} from "../shared/order-status";

const UK_MONTHS = [
  "січ.",
  "лют.",
  "бер.",
  "квіт.",
  "трав.",
  "черв.",
  "лип.",
  "серп.",
  "вер.",
  "жовт.",
  "лист.",
  "груд.",
] as const;

const EN_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Local calendar date. Invalid or empty ISO → empty string. */
export function formatOrderCreatedAt(iso: string, locale: Locale): string {
  if (iso.length === 0) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const day = date.getDate();
  const month = date.getMonth();
  const year = date.getFullYear();
  const months = locale === "uk" ? UK_MONTHS : EN_MONTHS;
  const monthLabel = months[month];
  if (monthLabel === undefined) {
    return "";
  }
  return `${String(day)} ${monthLabel} ${String(year)}`;
}

function itemCountLabel(
  count: number,
  locale: Locale,
  copy: OrdersCopy,
): string {
  return interpolate(copy.items[countPluralForm(count, locale)], {
    count: String(count),
  });
}

export type OrderRowView = {
  readonly id: string;
  readonly customerName: string;
  readonly status: OrderLifecycleStatus;
  readonly statusLabel: string;
  readonly statusTone: OrderStatusTone;
  readonly orderNumberLabel: string;
  readonly metaLabel: string;
  readonly totalLabel: string;
};

export function toOrderRowView(
  item: OrderListItem,
  args: {
    readonly locale: Locale;
    readonly copy: OrdersCopy;
  },
): OrderRowView {
  const created = formatOrderCreatedAt(item.createdAt, args.locale);
  return {
    id: item.orderId,
    customerName: localizeCustomerNameSnapshot(
      item.customer.nameSnapshot,
      args.copy.missingCustomer,
    ),
    status: item.status,
    statusLabel: args.copy.statuses[item.status],
    statusTone: orderStatusTone(item.status),
    orderNumberLabel: `#${item.orderNumber}`,
    metaLabel: `#${item.orderNumber} · ${itemCountLabel(item.itemCount, args.locale, args.copy)} · ${created}`,
    totalLabel: formatOrderMoney(item.totalGrossMinor, item.currency),
  };
}

export type OrderGroupKey = "active" | "closed";

export type OrdersListEntry =
  | {
      readonly type: "header";
      readonly key: OrderGroupKey;
      readonly count: number;
    }
  | { readonly type: "row"; readonly order: OrderRowView };

export function groupOrderRows(
  rows: readonly OrderRowView[],
): readonly OrdersListEntry[] {
  const active = rows.filter((row) => isOpenOrderStatus(row.status));
  const closed = rows.filter((row) => isClosedOrderStatus(row.status));
  const entries: OrdersListEntry[] = [];
  if (active.length > 0) {
    entries.push({
      type: "header",
      key: "active",
      count: active.length,
    });
    for (const order of active) {
      entries.push({ type: "row", order });
    }
  }
  if (closed.length > 0) {
    entries.push({
      type: "header",
      key: "closed",
      count: closed.length,
    });
    for (const order of closed) {
      entries.push({ type: "row", order });
    }
  }
  return entries;
}

export type OrdersListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "empty-filtered" }
  | { readonly kind: "empty-catalog" }
  | { readonly kind: "rows" };

export function classifyOrdersList(args: {
  readonly status: "pending" | "error" | "success";
  readonly rowCount: number;
  readonly hasStatusFilter: boolean;
  readonly hasSearch: boolean;
}): OrdersListState {
  if (args.status === "pending") {
    return { kind: "loading" };
  }
  if (args.status === "error") {
    return { kind: "error" };
  }
  if (args.rowCount > 0) {
    return { kind: "rows" };
  }
  return args.hasStatusFilter || args.hasSearch
    ? { kind: "empty-filtered" }
    : { kind: "empty-catalog" };
}
