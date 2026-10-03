/**
 * Pure view-model logic for the orders list (SHO-211 / SHO-351). No
 * React Native imports so the whole decision surface is unit-testable.
 */
import type { QueryFailureKind } from "../../../api/errors";
import type { ListRowGroupEdge } from "../../../components/ui/list-row-chrome";
import { formatMoneyMinor } from "../../../format/money";
import { interpolate, type Locale } from "../../../i18n/locale";
import type { OrdersCopy } from "../../../i18n/orders";
import { localizeCustomerNameSnapshot } from "../shared/customer-name";
import { itemCountLabel } from "../shared/item-count";
import { LIST_ORDERS_QUERY_MAX } from "../shared/order-caps";
import { formatOrderCreatedAt } from "../shared/order-created-at";
import {
  isClosedOrderStatus,
  isOpenOrderStatus,
  ORDER_LIFECYCLE_STATUSES,
  orderStatusTone,
  type OrderStatusTone,
} from "../shared/order-status";
import type {
  ListOrdersPageInput,
  OrderListItem,
  OrderStatusFilter,
} from "../api/order.queries";

export { LIST_ORDERS_QUERY_MAX, formatOrderCreatedAt };

export { orderStatusTone, type OrderStatusTone };
export { isClosedOrderStatus, isOpenOrderStatus };
export type { OrderStatusFilter, ListOrdersPageInput };

export const ORDER_STATUS_FILTERS: readonly OrderStatusFilter[] =
  ORDER_LIFECYCLE_STATUSES;

export function flattenOrderPages(
  pages: ReadonlyArray<{ readonly items: readonly OrderListItem[] }>,
): readonly OrderListItem[] {
  return pages.flatMap((page) => page.items);
}

export function sortOrderStatusFilters(
  selected: readonly OrderStatusFilter[],
): readonly OrderStatusFilter[] {
  return ORDER_STATUS_FILTERS.filter((status) => selected.includes(status));
}

export function toggleOrderStatusFilter(
  selected: readonly OrderStatusFilter[],
  status: OrderStatusFilter,
): readonly OrderStatusFilter[] {
  const next = selected.includes(status)
    ? selected.filter((item) => item !== status)
    : [...selected, status];
  return sortOrderStatusFilters(next);
}

/** Empty and whitespace-only searches are "no search" — the action rejects them. */
export function normalizeOrdersSearch(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, LIST_ORDERS_QUERY_MAX);
}

export function listOrdersPageInput(
  selected: readonly OrderStatusFilter[],
  search: string | undefined,
): ListOrdersPageInput {
  const filter =
    selected.length === 0 && search === undefined
      ? undefined
      : {
          ...(selected.length === 0 ? {} : { statuses: [...selected] }),
          ...(search === undefined ? {} : { query: search }),
        };
  return {
    kind: "page.summary",
    ...(filter === undefined ? {} : { filter }),
  };
}

export function hasActiveStatusFilter(
  selected: readonly OrderStatusFilter[],
): boolean {
  return selected.length > 0;
}

export type OrderRowView = {
  readonly id: string;
  readonly customerName: string;
  readonly status: OrderStatusFilter;
  readonly statusLabel: string;
  readonly statusTone: OrderStatusTone;
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
  return {
    id: item.orderId,
    customerName: localizeCustomerNameSnapshot(
      item.customer.nameSnapshot,
      args.copy.missingCustomer,
    ),
    status: item.status,
    statusLabel: args.copy.statuses[item.status],
    statusTone: orderStatusTone(item.status),
    metaLabel: `#${item.orderNumber} · ${itemCountLabel(item.itemCount, args.locale, args.copy.items)} · ${formatOrderCreatedAt(item.createdAt, args.locale)}`,
    totalLabel: formatMoneyMinor(item.totalGrossMinor, item.currency),
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

export function orderGroupHeaderLabel(
  key: OrderGroupKey,
  count: number,
  copy: OrdersCopy,
): string {
  return interpolate(copy.groupCount, {
    title: copy.groups[key],
    count: String(count),
  });
}

export function stickyHeaderIndices(
  entries: readonly OrdersListEntry[],
): number[] {
  const indices: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.type === "header") {
      indices.push(index);
    }
  }
  return indices;
}

/**
 * ListSurface cannot wrap the orders FlashList — sticky group headers
 * sit on canvas. Split the rounded surface across row cells instead.
 */
export function orderListGroupEdge(
  entries: readonly OrdersListEntry[],
  index: number,
): ListRowGroupEdge | null {
  const item = entries[index];
  if (item === undefined || item.type !== "row") {
    return null;
  }
  const prev = entries[index - 1];
  const next = entries[index + 1];
  const start = prev === undefined || prev.type === "header";
  const end = next === undefined || next.type === "header";
  if (start && end) {
    return "only";
  }
  if (start) {
    return "start";
  }
  if (end) {
    return "end";
  }
  return "middle";
}

export type OrdersListState =
  | { readonly kind: "loading" }
  | { readonly kind: "offline" }
  | { readonly kind: "error" }
  | { readonly kind: "empty-filtered" }
  | { readonly kind: "empty-catalog" }
  | { readonly kind: "rows" };

/**
 * Canvas state machine: skeletons while loading, offline vs error,
 * then filtered-empty (status and/or search) vs catalog-empty. Status
 * filters are server-side `filter.statuses`; an empty page is terminal
 * (no client-side multi-status paging). Search is also server-side.
 */
export function classifyOrdersList(args: {
  readonly clientReady: boolean;
  readonly status: "pending" | "error" | "success";
  readonly failureKind: QueryFailureKind | null;
  readonly rowCount: number;
  readonly hasStatusFilter: boolean;
  readonly hasSearch: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
}): OrdersListState {
  if (!args.clientReady) {
    return { kind: "error" };
  }
  if (args.status === "pending") {
    return { kind: "loading" };
  }
  if (args.status === "error") {
    return args.failureKind === "offline"
      ? { kind: "offline" }
      : { kind: "error" };
  }
  if (args.rowCount > 0) {
    return { kind: "rows" };
  }
  return args.hasStatusFilter || args.hasSearch
    ? { kind: "empty-filtered" }
    : { kind: "empty-catalog" };
}
