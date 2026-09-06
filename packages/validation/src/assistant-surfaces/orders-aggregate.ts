/**
 * Unlocalized orders-aggregate surface parse (SHO-456). Binds
 * `orders_list_counts`. Compose skips this kind when a list page is on
 * the same turn.
 */
import {
  grossAmounts,
  isRecord,
  lastSuccessfulResult,
  quantityMilliWire,
  unwrapToolOutput,
  type AssistantMoneyMinor,
  type AssistantSurfaceToolResult,
} from "./helpers.js";
import { ORDERS_LIST_COUNTS_TOOL } from "./orders-list.js";

export const ORDERS_AGGREGATE_SURFACE_TOOLS = [
  ORDERS_LIST_COUNTS_TOOL,
] as const;

export const ORDERS_AGGREGATE_PROMPT_LINE =
  "After orders_list_counts with no page on the same turn, the UI already shows the orders aggregate card with period, totals, and a status breakdown. Reply with a short product-language summary of the totals. Do not dump a markdown table of buckets. Do not call orders_list_counts or orders.list again for the card.";

export type AssistantOrdersAggregateGroupBy =
  "none" | "status" | "product" | "customer";

export function isAssistantOrdersAggregateGroupBy(
  value: unknown,
): value is AssistantOrdersAggregateGroupBy {
  return (
    value === "none" ||
    value === "status" ||
    value === "product" ||
    value === "customer"
  );
}

export type AssistantOrdersAggregateStatusBucketData = {
  readonly status: string;
  readonly orderCount: number;
  readonly gross: readonly AssistantMoneyMinor[];
};

export type AssistantOrdersAggregateProductBucketData = {
  readonly identityKind: "product";
  readonly id: string;
  readonly name: string;
  readonly orderCount: number;
  readonly gross: readonly AssistantMoneyMinor[];
  readonly quantityMilli: string | null;
};

export type AssistantOrdersAggregateCustomerBucketData = {
  readonly identityKind: "customer";
  readonly id: string;
  readonly nameSnapshot: string | null;
  readonly orderCount: number;
  readonly gross: readonly AssistantMoneyMinor[];
};

export type AssistantOrdersAggregateExtraBucketData =
  | AssistantOrdersAggregateProductBucketData
  | AssistantOrdersAggregateCustomerBucketData;

export type AssistantOrdersAggregateData = {
  readonly kind: "orders-aggregate";
  readonly groupBy: AssistantOrdersAggregateGroupBy;
  readonly orderCount: number;
  readonly gross: readonly AssistantMoneyMinor[];
  readonly statusBuckets: readonly AssistantOrdersAggregateStatusBucketData[];
  readonly extraBuckets: readonly AssistantOrdersAggregateExtraBucketData[];
  readonly customerMatchTruncated: boolean;
  readonly bucketsTruncated: boolean;
  readonly bucketsOmitted: number;
  readonly clipped: boolean;
};

function inferAggregateGroupBy(
  buckets: readonly unknown[],
): AssistantOrdersAggregateGroupBy {
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity)) {
      continue;
    }
    if (identity["kind"] === "product") {
      return "product";
    }
    if (identity["kind"] === "customer") {
      return "customer";
    }
    if (identity["kind"] === "status") {
      return "status";
    }
    if (identity["kind"] === "none") {
      return "none";
    }
  }
  return "status";
}

function parseStatusBuckets(
  buckets: readonly unknown[],
): AssistantOrdersAggregateStatusBucketData[] {
  const byStatus = new Map<string, AssistantOrdersAggregateStatusBucketData>();
  for (const bucket of buckets) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity) || identity["kind"] !== "status") {
      continue;
    }
    const status = identity["status"];
    if (typeof status !== "string" || status.length === 0) {
      continue;
    }
    const count =
      typeof bucket["orderCount"] === "number" ? bucket["orderCount"] : 0;
    byStatus.set(status, {
      status,
      orderCount: count,
      gross: grossAmounts(bucket["grossByCurrency"]),
    });
  }
  return [...byStatus.values()];
}

function parseProductBuckets(
  buckets: readonly unknown[],
): AssistantOrdersAggregateProductBucketData[] {
  const rows: AssistantOrdersAggregateProductBucketData[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity) || identity["kind"] !== "product") {
      continue;
    }
    const productId =
      typeof identity["productId"] === "string" ? identity["productId"] : "";
    const variantId =
      typeof identity["variantId"] === "string" ? identity["variantId"] : "";
    const name = typeof bucket["label"] === "string" ? bucket["label"] : "";
    const count =
      typeof bucket["orderCount"] === "number" ? bucket["orderCount"] : 0;
    const id =
      productId.length > 0
        ? `${productId}:${variantId}`
        : `product:${String(index)}`;
    rows.push({
      identityKind: "product",
      id,
      name,
      orderCount: count,
      gross: grossAmounts(bucket["grossByCurrency"]),
      quantityMilli: quantityMilliWire(bucket["quantityMilli"]),
    });
  }
  return rows;
}

function parseCustomerBuckets(
  buckets: readonly unknown[],
): AssistantOrdersAggregateCustomerBucketData[] {
  const rows: AssistantOrdersAggregateCustomerBucketData[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (!isRecord(bucket)) {
      continue;
    }
    const identity = bucket["identity"];
    if (!isRecord(identity) || identity["kind"] !== "customer") {
      continue;
    }
    const customerId =
      typeof identity["customerId"] === "string" ? identity["customerId"] : "";
    const nameSnapshot =
      typeof identity["nameSnapshot"] === "string"
        ? identity["nameSnapshot"]
        : typeof bucket["label"] === "string"
          ? bucket["label"]
          : "";
    const count =
      typeof bucket["orderCount"] === "number" ? bucket["orderCount"] : 0;
    const id = customerId.length > 0 ? customerId : `customer:${String(index)}`;
    rows.push({
      identityKind: "customer",
      id,
      nameSnapshot: nameSnapshot.length > 0 ? nameSnapshot : null,
      orderCount: count,
      gross: grossAmounts(bucket["grossByCurrency"]),
    });
  }
  return rows;
}

function parseExtraBuckets(
  groupBy: AssistantOrdersAggregateGroupBy,
  buckets: readonly unknown[],
): readonly AssistantOrdersAggregateExtraBucketData[] {
  switch (groupBy) {
    case "product":
      return parseProductBuckets(buckets);
    case "customer":
      return parseCustomerBuckets(buckets);
    case "status":
    case "none":
      return [];
  }
}

/**
 * Counts-only aggregate. Compose must not call this when a list page is
 * already on the turn.
 */
export function parseOrdersAggregateSurface(
  results: readonly AssistantSurfaceToolResult[],
): AssistantOrdersAggregateData | null {
  const countsResult = lastSuccessfulResult(
    results,
    (name) => name === ORDERS_LIST_COUNTS_TOOL,
  );
  if (countsResult === null) {
    return null;
  }
  const { payload, clipped } = unwrapToolOutput(countsResult.output);
  if (!isRecord(payload) || payload["kind"] !== "aggregate") {
    return null;
  }
  const rawBuckets = payload["buckets"];
  const buckets = Array.isArray(rawBuckets) ? rawBuckets : [];
  const rawStatusBuckets = payload["statusBuckets"];
  const statusSource = Array.isArray(rawStatusBuckets) ? rawStatusBuckets : [];
  const groupBy = inferAggregateGroupBy(buckets);
  const omitted = payload["bucketsOmitted"];
  return {
    kind: "orders-aggregate",
    groupBy,
    orderCount:
      typeof payload["orderCount"] === "number" ? payload["orderCount"] : 0,
    gross: grossAmounts(payload["grossByCurrency"]),
    statusBuckets: parseStatusBuckets(statusSource),
    extraBuckets: parseExtraBuckets(groupBy, buckets),
    customerMatchTruncated: payload["customerMatchTruncated"] === true,
    bucketsTruncated: payload["bucketsTruncated"] === true,
    bucketsOmitted: typeof omitted === "number" && omitted > 0 ? omitted : 0,
    clipped,
  };
}
