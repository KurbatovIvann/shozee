import { orderItems, orders } from "@showzy/db/schema/orders";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { recordCountsSql } from "@showzy/validation/record-verification";
import {
  and,
  count,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";

import {
  LIST_ORDERS_AGGREGATE_BUCKETS_MAX,
  type ListOrdersBucket,
  type ListOrdersInput,
  type ListOrdersOutput,
  type ListOrdersStatusBucket,
} from "../../actions/list.contract.js";
import { parseStatus } from "../parse-status.js";
import {
  grossByCurrencyFromMap,
  headerPredicates,
  mergeGross,
  toBigint,
  toCount,
  type QueryMatch,
  type StaffCtx,
} from "./filter.js";

type ListInput = ListOrdersInput;
type Bucket = ListOrdersBucket;
type ListOutput = ListOrdersOutput;

/**
 * Totals consult the shared verification predicate (SHO-466 / SHO-489).
 * Under the narrow default this is `TRUE`. Do not re-express
 * vouched/created_via filters here — flip `RECORD_VERIFICATION.mode`
 * instead. Money-shaped answers (revenue, gross by currency) exclude
 * unvouched rows; operational answers do not (SHO-464).
 */
function recordCountsPredicate(): SQL {
  return recordCountsSql(
    {
      createdVia: orders.createdVia,
      vouchedBy: orders.vouchedBy,
    },
    {
      alwaysTrue: sql`true`,
      isNull: (column) => isNull(column),
      isNotNull: (column) => isNotNull(column),
      eq: (column, value) => eq(column, value),
      or: (clauses) => or(...clauses) ?? sql`true`,
    },
  );
}

type MutableBucket = {
  identity: Bucket["identity"];
  label: string;
  sortKey: string;
  newestAt: number;
  newestId: string;
  orderCount: number;
  quantityMilli: bigint;
  gross: Map<string, bigint>;
};

function addGrossRow(
  bucket: MutableBucket,
  currency: string,
  amount: bigint,
  createdAt: Date,
  orderId: string,
  label: string,
): void {
  mergeGross(bucket.gross, currency, amount);
  const at = createdAt.getTime();
  if (
    at > bucket.newestAt ||
    (at === bucket.newestAt && orderId > bucket.newestId)
  ) {
    bucket.newestAt = at;
    bucket.newestId = orderId;
    bucket.label = label;
  }
}

function toOutputBucket(bucket: MutableBucket): Bucket {
  const grossByCurrency = grossByCurrencyFromMap(bucket.gross);
  if (bucket.identity.kind === "product") {
    return {
      identity: bucket.identity,
      label: bucket.label,
      orderCount: bucket.orderCount,
      grossByCurrency,
      quantityMilli: moneyToCanonical(bucket.quantityMilli),
    };
  }
  return {
    identity: bucket.identity,
    label: bucket.label,
    orderCount: bucket.orderCount,
    grossByCurrency,
  };
}

function toStatusOutputBuckets(
  buckets: readonly MutableBucket[],
): ListOrdersStatusBucket[] {
  const out: ListOrdersStatusBucket[] = [];
  for (const bucket of sortAndCapBuckets([...buckets]).buckets) {
    if (bucket.identity.kind !== "status") {
      continue;
    }
    out.push({
      identity: bucket.identity,
      label: bucket.label,
      orderCount: bucket.orderCount,
      grossByCurrency: bucket.grossByCurrency,
    });
  }
  return out;
}

async function queryStatusBuckets(
  ctx: StaffCtx,
  where: ReturnType<typeof and>,
): Promise<MutableBucket[]> {
  const rows = await ctx.db
    .select({
      status: orders.status,
      currency: orders.currency,
      orderCount: count(),
      grossMinor: sum(orders.totalGrossMinor),
      newestAt: sql<Date>`max(${orders.createdAt})`,
      newestId: sql<string>`(array_agg(${orders.id} ORDER BY ${orders.createdAt} DESC, ${orders.id} DESC))[1]`,
    })
    .from(orders)
    .where(where)
    .groupBy(orders.status, orders.currency);

  const byStatus = new Map<string, MutableBucket>();
  for (const row of rows) {
    const status = parseStatus(row.status);
    const existing = byStatus.get(status);
    const bucket =
      existing ??
      ({
        identity: { kind: "status", status },
        label: status,
        sortKey: status,
        newestAt: 0,
        newestId: "",
        orderCount: 0,
        quantityMilli: 0n,
        gross: new Map(),
      } satisfies MutableBucket);
    bucket.orderCount += toCount(row.orderCount);
    addGrossRow(
      bucket,
      row.currency,
      toBigint(row.grossMinor),
      new Date(row.newestAt),
      row.newestId,
      status,
    );
    byStatus.set(status, bucket);
  }
  return [...byStatus.values()];
}

function sortAndCapBuckets(buckets: MutableBucket[]): {
  readonly buckets: Bucket[];
  readonly bucketsTruncated: boolean;
} {
  const sorted = buckets.toSorted((left, right) => {
    if (left.orderCount !== right.orderCount) {
      return right.orderCount - left.orderCount;
    }
    return left.sortKey.localeCompare(right.sortKey);
  });
  const truncated = sorted.length > LIST_ORDERS_AGGREGATE_BUCKETS_MAX;
  const capped = truncated
    ? sorted.slice(0, LIST_ORDERS_AGGREGATE_BUCKETS_MAX)
    : sorted;
  return {
    bucketsTruncated: truncated,
    buckets: capped.map(toOutputBucket),
  };
}

export async function listAggregate(
  ctx: StaffCtx,
  input: Extract<ListInput, { kind: "aggregate" }>,
  queryMatch: QueryMatch,
): Promise<ListOutput> {
  const where = and(
    ...headerPredicates(ctx, input.filter, queryMatch.predicate),
    recordCountsPredicate(),
  );
  const totals = await ctx.db
    .select({
      currency: orders.currency,
      orderCount: count(),
      grossMinor: sum(orders.totalGrossMinor),
    })
    .from(orders)
    .where(where)
    .groupBy(orders.currency);

  const totalGross = new Map<string, bigint>();
  let orderCount = 0;
  for (const row of totals) {
    orderCount += toCount(row.orderCount);
    mergeGross(totalGross, row.currency, toBigint(row.grossMinor));
  }
  const grossByCurrency = grossByCurrencyFromMap(totalGross);
  const statusMutable = await queryStatusBuckets(ctx, where);
  const statusBuckets = toStatusOutputBuckets(statusMutable);

  if (input.groupBy === "none") {
    return {
      kind: "aggregate",
      orderCount,
      grossByCurrency,
      buckets: [
        {
          identity: { kind: "none" },
          label: "",
          orderCount,
          grossByCurrency,
        },
      ],
      bucketsTruncated: false,
      customerMatchTruncated: queryMatch.truncated,
      statusBuckets,
    };
  }

  if (input.groupBy === "status") {
    const capped = sortAndCapBuckets(statusMutable);
    return {
      kind: "aggregate",
      orderCount,
      grossByCurrency,
      buckets: capped.buckets,
      bucketsTruncated: capped.bucketsTruncated,
      customerMatchTruncated: queryMatch.truncated,
      statusBuckets,
    };
  }

  if (input.groupBy === "customer") {
    const rows = await ctx.db
      .select({
        customerId: orders.customerId,
        nameSnapshot: orders.customerNameSnapshot,
        currency: orders.currency,
        orderCount: count(),
        grossMinor: sum(orders.totalGrossMinor),
        newestAt: sql<Date>`max(${orders.createdAt})`,
        newestId: sql<string>`(array_agg(${orders.id} ORDER BY ${orders.createdAt} DESC, ${orders.id} DESC))[1]`,
        newestName: sql<string>`(array_agg(${orders.customerNameSnapshot} ORDER BY ${orders.createdAt} DESC, ${orders.id} DESC))[1]`,
      })
      .from(orders)
      .where(where)
      .groupBy(orders.customerId, orders.customerNameSnapshot, orders.currency);

    const byCustomer = new Map<string, MutableBucket>();
    for (const row of rows) {
      const identityKey =
        row.customerId === null
          ? `name:${row.nameSnapshot}`
          : `id:${row.customerId}`;
      const existing = byCustomer.get(identityKey);
      const label = row.newestName;
      const bucket =
        existing ??
        ({
          identity: {
            kind: "customer",
            customerId: row.customerId,
            nameSnapshot: label,
          },
          label,
          sortKey: identityKey,
          newestAt: 0,
          newestId: "",
          orderCount: 0,
          quantityMilli: 0n,
          gross: new Map(),
        } satisfies MutableBucket);
      bucket.orderCount += toCount(row.orderCount);
      addGrossRow(
        bucket,
        row.currency,
        toBigint(row.grossMinor),
        new Date(row.newestAt),
        row.newestId,
        label,
      );
      if (bucket.identity.kind === "customer") {
        bucket.identity = {
          kind: "customer",
          customerId: bucket.identity.customerId,
          nameSnapshot: bucket.label,
        };
      }
      byCustomer.set(identityKey, bucket);
    }
    const capped = sortAndCapBuckets([...byCustomer.values()]);
    return {
      kind: "aggregate",
      orderCount,
      grossByCurrency,
      buckets: capped.buckets,
      bucketsTruncated: capped.bucketsTruncated,
      customerMatchTruncated: queryMatch.truncated,
      statusBuckets,
    };
  }

  const productRows = await ctx.db
    .select({
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      currency: orderItems.currency,
      orderCount: sql<number>`count(distinct ${orderItems.orderId})`,
      grossMinor: sum(orderItems.grossAmountMinor),
      newestAt: sql<Date>`max(${orders.createdAt})`,
      newestId: sql<string>`(array_agg(${orders.id} ORDER BY ${orders.createdAt} DESC, ${orders.id} DESC))[1]`,
      newestTitle: sql<string>`(array_agg(${orderItems.titleSnapshot} ORDER BY ${orders.createdAt} DESC, ${orders.id} DESC))[1]`,
      quantityMilli: sum(orderItems.quantityMilli),
    })
    .from(orderItems)
    .innerJoin(
      orders,
      and(
        eq(orders.companyId, orderItems.companyId),
        eq(orders.id, orderItems.orderId),
      ),
    )
    .where(and(where, eq(orderItems.companyId, ctx.companyId)))
    .groupBy(orderItems.productId, orderItems.variantId, orderItems.currency);

  const byProduct = new Map<string, MutableBucket>();
  for (const row of productRows) {
    const variantKey = row.variantId ?? "";
    const identityKey = `product:${row.productId}:${variantKey}`;
    const existing = byProduct.get(identityKey);
    const label = row.newestTitle;
    const bucket =
      existing ??
      ({
        identity: {
          kind: "product",
          productId: row.productId,
          variantId: row.variantId,
        },
        label,
        sortKey: identityKey,
        newestAt: 0,
        newestId: "",
        orderCount: 0,
        quantityMilli: 0n,
        gross: new Map(),
      } satisfies MutableBucket);
    bucket.orderCount += toCount(row.orderCount);
    bucket.quantityMilli += toBigint(row.quantityMilli);
    addGrossRow(
      bucket,
      row.currency,
      toBigint(row.grossMinor),
      new Date(row.newestAt),
      row.newestId,
      label,
    );
    byProduct.set(identityKey, bucket);
  }
  const capped = sortAndCapBuckets([...byProduct.values()]);
  return {
    kind: "aggregate",
    orderCount,
    grossByCurrency,
    buckets: capped.buckets,
    bucketsTruncated: capped.bucketsTruncated,
    customerMatchTruncated: queryMatch.truncated,
    statusBuckets,
  };
}
