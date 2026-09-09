/**
 * Orders list result surface (SHO-369 / SHO-385 / SHO-456 / SHO-472).
 * Localizes shared `@showzy/validation/assistant-surfaces` data. Do not
 * walk `items[].orderId` into entity cards. Do not import `@showzy/ai`.
 */
import { sharedAssistantCopy } from "@showzy/copy/assistant";
import {
  assistantSurfaceHandoffHref,
  ORDERS_LIST_COUNTS_TOOL,
  ORDERS_LIST_PAGE_TOOL,
  ORDERS_LIST_PROMPT_LINE,
  ORDERS_LIST_SURFACE_TOOLS,
  ASSISTANT_ORDERS_LIST_ROW_MAX,
  ASSISTANT_ORDERS_LIST_SCREEN_HREF,
  type AssistantOrdersListData,
  type AssistantOrdersListRowData,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

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
import {
  localizeAssistantCollection,
  type AssistantCollectionView,
} from "./collection";
import { formatMoneyAmount, localizeCustomerName } from "./helpers";
import type { AssistantResultMarks } from "./marks";

export const ASSISTANT_ORDERS_LIST_HREF = ASSISTANT_ORDERS_LIST_SCREEN_HREF;

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
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly collection: AssistantCollectionView;
  readonly rows: readonly AssistantOrdersListRowView[];
  readonly chips: readonly AssistantOrdersListChipView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string | null;
  readonly ctaHref: typeof ASSISTANT_ORDERS_LIST_HREF | null;
  readonly marks?: AssistantResultMarks;
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

function collectionRowsFromLocalized(
  rows: readonly AssistantOrdersListRowView[],
): AssistantCollectionView["rows"] {
  return rows.map((row) => ({
    id: row.orderId,
    title: row.customerName,
    badge: row.statusLabel,
    badgeTone: row.statusTone,
    meta: row.metaLabel.length > 0 ? row.metaLabel : null,
    cells: row.totalLabel !== null ? [row.totalLabel] : [],
    href: row.href,
  }));
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
  const chrome = sharedAssistantCopy(locale).ordersList;
  const orders = ordersCopy(locale);
  const parsedRows = data.rows.map((row) =>
    localizeListRow(row, locale, orders),
  );
  const showCta = data.hasMore || data.nextCursor !== null;
  const destinationHref = assistantSurfaceHandoffHref(data.destination);
  const ctaHref =
    showCta && destinationHref !== ASSISTANT_ORDERS_LIST_HREF
      ? ASSISTANT_ORDERS_LIST_HREF
      : null;
  const footnotes: string[] = [];
  if (data.customerMatchTruncated) {
    footnotes.push(chrome.customerMatchTruncated);
  }
  if (data.clipped) {
    footnotes.push(chrome.clipped);
  }
  const empty = parsedRows.length === 0;
  return {
    kind: "orders-list",
    destination: data.destination,
    handoffLabel: chrome.openList,
    collection: localizeAssistantCollection(
      data.collection,
      collectionRowsFromLocalized(parsedRows),
    ),
    rows: parsedRows,
    chips: localizeChips(data, orders),
    emptyTitle: empty ? chrome.listEmptyTitle : null,
    emptyDescription: empty ? chrome.listEmptyDescription : null,
    footnotes,
    ctaLabel: ctaHref !== null ? chrome.openList : null,
    ctaHref,
  };
}
