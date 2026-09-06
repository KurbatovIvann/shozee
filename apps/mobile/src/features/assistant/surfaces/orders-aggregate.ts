/**
 * Orders aggregate result surface (SHO-370 / SHO-385 / SHO-395 / SHO-456).
 * Localizes shared `@showzy/validation/assistant-surfaces` data. Compose
 * skips this kind when a list page is on the same turn. Do not import
 * `@showzy/ai`.
 */
import {
  isAssistantOrdersAggregateGroupBy,
  isAssistantSurfaceResultOutput,
  isRecord,
  parseOrdersAggregateSurface as parseOrdersAggregateData,
  ORDERS_AGGREGATE_PROMPT_LINE,
  ORDERS_AGGREGATE_SURFACE_TOOLS,
  ORDERS_LIST_COUNTS_TOOL,
  type AssistantOrdersAggregateData,
  type AssistantOrdersAggregateExtraBucketData,
  type AssistantOrdersAggregateGroupBy,
  type AssistantSurfaceDestination,
} from "@showzy/validation/assistant-surfaces";

import { assistantCopy } from "../../../i18n/assistant";
import { interpolate, type Locale } from "../../../i18n/locale";
import { ordersCopy } from "../../../i18n/orders";
import { countPluralForm } from "../../../i18n/plural";
import { itemCountLabel } from "../../orders/shared/item-count";
import { formatOrderCreatedAt } from "../../orders/shared/order-created-at";
import {
  ORDER_LIFECYCLE_STATUSES as ORDER_STATUSES,
  orderStatusTone,
  type OrderLifecycleStatus,
  type OrderStatusTone,
} from "../../orders/shared/order-status";
import type { AssistantChatPart } from "../shared/confirmation-presenter";
import { toolNameFromPart } from "../shared/turn-timeline";
import {
  assistantSurfaceToolResultsFromParts,
  formatQuantityLabel,
  localizeCustomerName,
  moneyLabels,
} from "./helpers";
import { ASSISTANT_ORDERS_LIST_HREF } from "./orders-list";

export { ORDERS_AGGREGATE_PROMPT_LINE, ORDERS_AGGREGATE_SURFACE_TOOLS };

export type { AssistantOrdersAggregateGroupBy };

export type AssistantOrdersAggregateBucketView = {
  readonly id: string;
  readonly label: string;
  readonly orderCountLabel: string;
  readonly moneyLabels: readonly string[];
  readonly quantityLabel: string | null;
  readonly status: OrderLifecycleStatus | null;
  readonly statusTone: OrderStatusTone | null;
};

export type AssistantOrdersAggregateCardView = {
  readonly kind: "orders-aggregate";
  readonly destination: AssistantSurfaceDestination;
  readonly handoffLabel: string;
  readonly groupBy: AssistantOrdersAggregateGroupBy;
  readonly periodLabel: string | null;
  readonly orderCountLabel: string;
  readonly moneyLabels: readonly string[];
  readonly statusBuckets: readonly AssistantOrdersAggregateBucketView[];
  readonly extraBuckets: readonly AssistantOrdersAggregateBucketView[];
  readonly emptyTitle: string | null;
  readonly emptyDescription: string | null;
  readonly footnotes: readonly string[];
  readonly ctaLabel: string;
  readonly ctaHref: typeof ASSISTANT_ORDERS_LIST_HREF;
};

function orderCountLabel(
  count: number,
  locale: Locale,
  forms: ReturnType<typeof assistantCopy>["cards"]["orderCount"],
): string {
  return interpolate(forms[countPluralForm(count, locale)], {
    count: String(count),
  });
}

function parsePeriodLabel(
  input: unknown,
  locale: Locale,
  cards: ReturnType<typeof assistantCopy>["cards"],
): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const period = input["period"];
  if (period === "today") {
    return cards.periodToday;
  }
  if (period === "this_week") {
    return cards.periodThisWeek;
  }
  if (period === "this_month") {
    return cards.periodThisMonth;
  }
  const fromIso =
    typeof input["createdFrom"] === "string" ? input["createdFrom"] : "";
  const toIso =
    typeof input["createdTo"] === "string" ? input["createdTo"] : "";
  const from = fromIso.length > 0 ? formatOrderCreatedAt(fromIso, locale) : "";
  const to = toIso.length > 0 ? formatOrderCreatedAt(toIso, locale) : "";
  if (from.length > 0 && to.length > 0) {
    return from === to ? from : `${from} – ${to}`;
  }
  if (from.length > 0) {
    return from;
  }
  if (to.length > 0) {
    return to;
  }
  return null;
}

function lastCountsInput(parts: readonly AssistantChatPart[]): unknown {
  let found: unknown;
  for (const part of parts) {
    const toolName = toolNameFromPart(part);
    if (toolName !== ORDERS_LIST_COUNTS_TOOL) {
      continue;
    }
    if (part.state !== "output-available") {
      continue;
    }
    if (!isAssistantSurfaceResultOutput(part.output)) {
      continue;
    }
    found = part.input;
  }
  return found;
}

function localizeStatusBuckets(
  data: AssistantOrdersAggregateData,
  orders: ReturnType<typeof ordersCopy>,
): AssistantOrdersAggregateBucketView[] {
  const byStatus = new Map(
    data.statusBuckets.map((bucket) => [bucket.status, bucket]),
  );
  const rows: AssistantOrdersAggregateBucketView[] = [];
  for (const status of ORDER_STATUSES) {
    const bucket = byStatus.get(status);
    if (bucket === undefined) {
      continue;
    }
    rows.push({
      id: status,
      label: orders.statuses[status],
      orderCountLabel: String(bucket.orderCount),
      moneyLabels: moneyLabels(bucket.gross),
      quantityLabel: null,
      status,
      statusTone: orderStatusTone(status),
    });
  }
  return rows;
}

function localizeExtraBucket(
  bucket: AssistantOrdersAggregateExtraBucketData,
  missingCustomer: string,
): AssistantOrdersAggregateBucketView {
  if (bucket.identityKind === "product") {
    return {
      id: bucket.id,
      label: bucket.name,
      orderCountLabel: String(bucket.orderCount),
      moneyLabels: moneyLabels(bucket.gross),
      quantityLabel: formatQuantityLabel(bucket.quantityMilli),
      status: null,
      statusTone: null,
    };
  }
  return {
    id: bucket.id,
    label: localizeCustomerName(bucket.nameSnapshot, missingCustomer),
    orderCountLabel: String(bucket.orderCount),
    moneyLabels: moneyLabels(bucket.gross),
    quantityLabel: null,
    status: null,
    statusTone: null,
  };
}

function overlayGroupBy(
  data: AssistantOrdersAggregateData,
  input: unknown,
): AssistantOrdersAggregateGroupBy {
  if (isRecord(input) && isAssistantOrdersAggregateGroupBy(input["groupBy"])) {
    return input["groupBy"];
  }
  return data.groupBy;
}

export function localizeOrdersAggregateCard(
  data: AssistantOrdersAggregateData,
  locale: Locale,
  countsInput: unknown,
): AssistantOrdersAggregateCardView {
  const assistant = assistantCopy(locale);
  const orders = ordersCopy(locale);
  const groupBy = overlayGroupBy(data, countsInput);
  const parsedStatusBuckets = localizeStatusBuckets(data, orders);
  const extraBuckets =
    groupBy === "product" || groupBy === "customer"
      ? data.extraBuckets.map((bucket) =>
          localizeExtraBucket(bucket, orders.missingCustomer),
        )
      : [];
  const footnotes: string[] = [];
  if (data.customerMatchTruncated) {
    footnotes.push(assistant.cards.customerMatchTruncated);
  }
  if (data.bucketsTruncated) {
    footnotes.push(assistant.cards.bucketsTruncated);
  }
  if (data.bucketsOmitted > 0) {
    footnotes.push(
      itemCountLabel(
        data.bucketsOmitted,
        locale,
        assistant.cards.bucketsOmitted,
      ),
    );
  }
  if (data.clipped) {
    footnotes.push(assistant.cards.clipped);
  }
  const empty = parsedStatusBuckets.length === 0 && extraBuckets.length === 0;
  return {
    kind: "orders-aggregate",
    destination: data.destination,
    handoffLabel: assistant.cards.openOrders,
    groupBy,
    periodLabel: parsePeriodLabel(countsInput, locale, assistant.cards),
    orderCountLabel: orderCountLabel(
      data.orderCount,
      locale,
      assistant.cards.orderCount,
    ),
    moneyLabels: moneyLabels(data.gross),
    statusBuckets: parsedStatusBuckets,
    extraBuckets,
    emptyTitle: empty ? assistant.cards.aggregateEmptyTitle : null,
    emptyDescription: empty ? assistant.cards.aggregateEmptyDescription : null,
    footnotes,
    ctaLabel: assistant.cards.openOrders,
    ctaHref: ASSISTANT_ORDERS_LIST_HREF,
  };
}

/**
 * Counts-only aggregate. Compose must not call this when a list page is
 * already on the turn.
 */
export function parseOrdersAggregateSurface(
  parts: readonly AssistantChatPart[],
  locale: Locale,
): AssistantOrdersAggregateCardView | null {
  const data = parseOrdersAggregateData(
    assistantSurfaceToolResultsFromParts(parts),
  );
  if (data === null) {
    return null;
  }
  return localizeOrdersAggregateCard(data, locale, lastCountsInput(parts));
}
