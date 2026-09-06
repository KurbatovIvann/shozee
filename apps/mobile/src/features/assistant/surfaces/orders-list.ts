/**
 * Orders list result surface (SHO-369 / SHO-385 / SHO-456). Localizes
 * shared `@showzy/validation/assistant-surfaces` data. Do not walk
 * `items[].orderId` into entity cards. Do not import `@showzy/ai`.
 */
import {
  parseOrdersListSurface as parseOrdersListData,
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
  ORDERS_LIST_PROMPT_LINE,
  ORDERS_LIST_SURFACE_TOOLS,
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  type AssistantOrdersListData,
  type AssistantOrdersListRowData,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import type { Locale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import { itemCountLabel } from "../../orders/shared/item-count";
import { formatOrderCreatedAt } from "../../orders/shared/order-created-at";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import {
  isOrderLifecycleStatus as isOrderStatus,
  ORDER_LIFECYCLE_STATUSES as ORDER_STATUSES,
  orderStatusTone,
  type OrderLifecycleStatus,
  type OrderStatusTone,
} from "../../orders/shared/order-status";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import {
  assistantSurfaceToolResultsFromParts,
  formatMoneyAmount,
  localizeCustomerName,
} from "./helpers";

export const ASSISTANT_ORDERS_LIST_HREF = "/orders";

export {
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
  ORDERS_LIST_PROMPT_LINE,
  ORDERS_LIST_SURFACE_TOOLS,
};

export type AssistantOrdersListChipView = {
  readonly status: OrderLifecycleStatus;
  readonly label: string;
  readonly tone: OrderStatusTone;
};

export type AssistantOrdersListRowView = {
  readonly orderId: string;
  readonly href: string;
  readonly orderNumberLabel: string;
  readonly customerName: string;
  readonly statusLabel: string | null;
  readonly statusTone: OrderStatusTone;
  readonly metaLabel: string;
  readonly totalLabel: string | null;
};

export type AssistantOrdersListCardView = {
  readonly kind: "orders-list";
  readonly rows: readonly AssistantOrdersListRowView[];
  readonly chips: readonly AssistantOrdersListChipView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_ORDERS_LIST_HREF | null;
};

function formatCreatedAt(iso: string | null, locale: Locale): string {
  if (iso === null || iso.length === 0) {
    return "";
  }
  return formatOrderCreatedAt(iso, locale);
}

function joinMeta(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(" · ");
}

function localizeListRow(
  row: AssistantOrdersListRowData,
  locale: Locale,
  orders: ReturnType<typeof ordersCopy>,
): AssistantOrdersListRowView {
  const status = isOrderStatus(row.status) ? row.status : null;
  const itemMeta =
    row.itemCount !== null
      ? itemCountLabel(row.itemCount, locale, orders.items)
      : "";
  const created = formatCreatedAt(row.createdAt, locale);
  const numberLabel = row.orderNumber.length > 0 ? `#${row.orderNumber}` : "";
  return {
    orderId: row.orderId,
    href: orderDetailHref(row.orderId),
    orderNumberLabel: numberLabel,
    customerName: localizeCustomerName(
      row.customerNameSnapshot,
      orders.missingCustomer,
    ),
    statusLabel: status !== null ? orders.statuses[status] : null,
    statusTone: status !== null ? orderStatusTone(status) : "action",
    metaLabel: joinMeta([numberLabel, itemMeta, created]),
    totalLabel: formatMoneyAmount(row.total),
  };
}

function localizeChips(
  data: AssistantOrdersListData,
  orders: ReturnType<typeof ordersCopy>,
): readonly AssistantOrdersListChipView[] {
  const counts = new Map<string, number>();
  for (const chip of data.chips) {
    counts.set(chip.status, chip.orderCount);
  }
  const chips: AssistantOrdersListChipView[] = [];
  for (const status of ORDER_STATUSES) {
    const count = counts.get(status);
    if (count === undefined) {
      continue;
    }
    chips.push({
      status,
      label: `${orders.statuses[status]} · ${String(count)}`,
      tone: orderStatusTone(status),
    });
  }
  return chips;
}

export function localizeOrdersListCard(
  data: AssistantOrdersListData,
  locale: Locale,
): AssistantOrdersListCardView {
  const assistant = assistantCopy(locale);
  const orders = ordersCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizeListRow(row, locale, orders),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const footnotes: string[] = [];
  if (data.customerMatchTruncated) {
    footnotes.push(assistant.cards.customerMatchTruncated);
  }
  if (data.clipped) {
    footnotes.push(assistant.cards.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "orders-list",
    rows: parsedRows,
    chips: localizeChips(data, orders),
    emptyTitle: empty ? assistant.cards.listEmptyTitle : null,
    emptyDescription: empty ? assistant.cards.listEmptyDescription : null,
    footnotes,
    ctaLabel: showCta ? assistant.cards.openOrders : null,
    ctaHref: showCta ? ASSISTANT_ORDERS_LIST_HREF : null,
  };
}

/**
 * One list surface when a live `orders_list_page` result is present.
 * Chips come from same-turn `orders_list_counts`. Returns null when there
 * is no successful page — counts-only is the aggregate kind.
 */
export function parseOrdersListSurface(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): AssistantOrdersListCardView | null {
  const data = parseOrdersListData(assistantSurfaceToolResultsFromParts(parts));
  if (data === null) {
    return null;
  }
  return localizeOrdersListCard(data, locale);
}
