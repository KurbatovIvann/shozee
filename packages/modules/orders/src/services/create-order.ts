import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { ConflictError, CoreInvariantError } from "@showzy/core/errors";
import {
  orderItems,
  orderNumberCounters,
  orders,
} from "@showzy/db/schema/orders";
import {
  moneyFromCanonical,
  moneyToCanonical,
} from "@showzy/module-kit/canonical";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import type { CreateOrderSummary } from "../actions/create.contract.js";
import {
  orderPriceSourceSchema,
  orderViewSchema,
} from "../actions/order-view.contract.js";
import { ordersCreated } from "../events/created.js";
import { computeExemptNoneLine, titleSnapshot } from "./line-money.js";
import { formatStaffOrderNumber } from "./order-number-format.js";
import { mapOrderNumberUniqueViolation } from "./order-number.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type OrderView = z.output<typeof orderViewSchema>;
type OrderItemView = OrderView["items"][number];
type PriceSource = z.output<typeof orderPriceSourceSchema>;
type WritableStaffDb = ReturnType<typeof requireWritable>;

/**
 * Unique backstop: 23505 on `orders_company_id_order_number_uq`.
 * Counter upsert stays on the outer write tx (not rolled back). INSERT
 * is a nested `db.transaction` savepoint so Postgres 25P02 does not
 * abort the action tx; the next loop allocates `last_number + 1`.
 */
const ORDER_NUMBER_ALLOCATE_ATTEMPTS = 8;

export interface PersistedCreateLine {
  readonly productId: string;
  readonly variantId: string | null;
  readonly quantityMilli: string;
  readonly productName: string;
  readonly variantName: string | null;
}

export interface ResolvedOrderPrice {
  readonly productId: string;
  readonly variantId: string | null;
  readonly unitPriceMinor: string;
  readonly currency: string;
  readonly source: PriceSource;
  readonly sourceIds: {
    readonly personalPriceId?: string | undefined;
    readonly priceListId?: string | undefined;
    readonly entryId?: string | undefined;
  };
  readonly resolverVersion: number;
}

interface PersistedLine {
  readonly view: OrderItemView;
  readonly row: typeof orderItems.$inferInsert;
}

async function allocateNextOrderSequence(
  db: WritableStaffDb,
  companyId: string,
): Promise<bigint> {
  const allocated = (
    await db
      .insert(orderNumberCounters)
      .values({
        companyId,
        lastNumber: 1n,
      })
      .onConflictDoUpdate({
        target: [orderNumberCounters.companyId],
        set: {
          lastNumber: sql`${orderNumberCounters.lastNumber} + 1`,
        },
      })
      .returning({ lastNumber: orderNumberCounters.lastNumber })
  )[0];
  if (allocated === undefined) {
    throw new CoreInvariantError(
      "orders.create counter upsert returned no row",
    );
  }
  return allocated.lastNumber;
}

async function insertNumberedHeader(
  db: WritableStaffDb,
  values: {
    readonly id: string;
    readonly companyId: string;
    readonly numberingPrefix: string;
    readonly customerId: string;
    readonly customerNameSnapshot: string;
    readonly comment: string | null;
    readonly totalNetMinor: bigint;
    readonly totalTaxMinor: bigint;
    readonly totalGrossMinor: bigint;
    readonly currency: string;
    readonly createdVia: StaffCtx["channel"];
  },
): Promise<{ createdAt: Date; orderNumber: string }> {
  let lastConflict: ConflictError | undefined;
  for (
    let attempt = 0;
    attempt < ORDER_NUMBER_ALLOCATE_ATTEMPTS;
    attempt += 1
  ) {
    const sequence = await allocateNextOrderSequence(db, values.companyId);
    const orderNumber = formatStaffOrderNumber(
      values.numberingPrefix,
      sequence,
    );
    try {
      return await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(orders)
          .values({
            id: values.id,
            companyId: values.companyId,
            orderNumber,
            customerId: values.customerId,
            customerNameSnapshot: values.customerNameSnapshot,
            status: "new",
            comment: values.comment,
            totalNetMinor: values.totalNetMinor,
            totalTaxMinor: values.totalTaxMinor,
            totalGrossMinor: values.totalGrossMinor,
            currency: values.currency,
            createdVia: values.createdVia,
          })
          .returning({
            createdAt: orders.createdAt,
            orderNumber: orders.orderNumber,
          });
        const row = inserted[0];
        if (row === undefined) {
          throw new CoreInvariantError("orders.create insert returned no row");
        }
        return row;
      });
    } catch (error) {
      const mapped = mapOrderNumberUniqueViolation(error);
      if (!(mapped instanceof ConflictError)) {
        throw mapped;
      }
      lastConflict = mapped;
    }
  }
  throw (
    lastConflict ??
    new CoreInvariantError("orders.create failed to allocate order_number")
  );
}

function requirePriceSource(value: string): PriceSource {
  return parseDbEnum(
    orderPriceSourceSchema,
    value,
    `resolved price source "${value}" is not a snapshot provenance value`,
  );
}

function validatePriceAlignment(
  item: PersistedCreateLine,
  price: ResolvedOrderPrice,
  index: number,
): void {
  if (
    price.productId !== item.productId ||
    price.variantId !== item.variantId
  ) {
    throw new CoreInvariantError(
      `pricing.resolveProductPrices row ${String(index)} does not match the create line`,
    );
  }
}

function orderItemInsertFromView(
  view: OrderItemView,
  companyId: string,
  orderId: string,
): typeof orderItems.$inferInsert {
  return {
    id: view.itemId,
    companyId,
    orderId,
    productId: view.productId,
    variantId: view.variantId,
    titleSnapshot: view.titleSnapshot,
    quantityMilli: moneyFromCanonical(view.quantityMilli),
    unitPriceMinor: moneyFromCanonical(view.unitPriceMinor),
    discountKind: view.discountKind,
    discountValue: moneyFromCanonical(view.discountValue),
    discountAmountMinor: moneyFromCanonical(view.discountAmountMinor),
    taxTreatment: view.taxTreatment,
    taxRateBp: view.taxRateBp,
    taxAmountMinor: moneyFromCanonical(view.taxAmountMinor),
    netAmountMinor: moneyFromCanonical(view.netAmountMinor),
    grossAmountMinor: moneyFromCanonical(view.grossAmountMinor),
    currency: view.currency,
    priceSource: view.priceSource,
    personalPriceId: view.personalPriceId,
    priceListId: view.priceListId,
    priceListEntryId: view.priceListEntryId,
    resolverVersion: view.resolverVersion,
  };
}

function buildOrderLine(args: {
  readonly item: PersistedCreateLine;
  readonly price: ResolvedOrderPrice;
  readonly companyId: string;
  readonly orderId: string;
}): PersistedLine {
  const amounts = computeExemptNoneLine(
    BigInt(args.price.unitPriceMinor),
    BigInt(args.item.quantityMilli),
  );
  const view: OrderItemView = {
    itemId: randomUUID(),
    productId: args.item.productId,
    variantId: args.item.variantId,
    titleSnapshot: titleSnapshot(
      args.item.productName,
      args.item.variantName ?? undefined,
    ),
    quantityMilli: args.item.quantityMilli,
    unitPriceMinor: args.price.unitPriceMinor,
    discountKind: amounts.discountKind,
    discountValue: moneyToCanonical(amounts.discountValue),
    discountAmountMinor: moneyToCanonical(amounts.discountAmountMinor),
    taxTreatment: amounts.taxTreatment,
    taxRateBp: amounts.taxRateBp,
    taxAmountMinor: moneyToCanonical(amounts.taxAmountMinor),
    netAmountMinor: moneyToCanonical(amounts.netAmountMinor),
    grossAmountMinor: moneyToCanonical(amounts.grossAmountMinor),
    currency: args.price.currency,
    priceSource: requirePriceSource(args.price.source),
    personalPriceId: args.price.sourceIds.personalPriceId ?? null,
    priceListId: args.price.sourceIds.priceListId ?? null,
    priceListEntryId: args.price.sourceIds.entryId ?? null,
    resolverVersion: args.price.resolverVersion,
  };
  return {
    view,
    row: orderItemInsertFromView(view, args.companyId, args.orderId),
  };
}

/**
 * Persistence accepts only canonical UUIDs + milli (never a human
 * reference or decimal quantity). Names come from
 * `catalog.resolveLineReferences`.
 */
export async function createStaffOrder(env: {
  readonly ctx: StaffCtx;
  readonly customerId: string;
  readonly customerNameSnapshot: string;
  readonly items: readonly PersistedCreateLine[];
  readonly comment: string | undefined;
  readonly numberingPrefix: string;
  readonly prices: readonly ResolvedOrderPrice[];
}): Promise<CreateOrderSummary> {
  const {
    ctx,
    customerId,
    customerNameSnapshot,
    items,
    comment,
    numberingPrefix,
    prices,
  } = env;
  if (prices.length !== items.length) {
    throw new CoreInvariantError(
      "pricing.resolveProductPrices returned a different item count than create input",
    );
  }

  const first = prices[0];
  if (first === undefined) {
    throw new CoreInvariantError(
      "create input passed Zod min(1) with no prices",
    );
  }
  const currency = first.currency;
  for (const price of prices) {
    if (price.currency !== currency) {
      throw new ConflictError("Order items must share a single currency.");
    }
  }

  const orderId = randomUUID();
  const lines: PersistedLine[] = [];
  let totalNetMinor = 0n;
  let totalTaxMinor = 0n;
  let totalGrossMinor = 0n;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const price = prices[index];
    if (item === undefined || price === undefined) {
      throw new CoreInvariantError("create line zip went out of range");
    }
    validatePriceAlignment(item, price, index);
    const line = buildOrderLine({
      item,
      price,
      companyId: ctx.companyId,
      orderId,
    });
    lines.push(line);
    totalNetMinor += moneyFromCanonical(line.view.netAmountMinor);
    totalTaxMinor += moneyFromCanonical(line.view.taxAmountMinor);
    totalGrossMinor += moneyFromCanonical(line.view.grossAmountMinor);
  }

  const persistedComment = comment ?? null;
  const db = requireWritable(ctx.db);
  const header = await insertNumberedHeader(db, {
    id: orderId,
    companyId: ctx.companyId,
    numberingPrefix,
    customerId,
    customerNameSnapshot,
    comment: persistedComment,
    totalNetMinor,
    totalTaxMinor,
    totalGrossMinor,
    currency,
    createdVia: ctx.channel,
  });

  await db.insert(orderItems).values(lines.map((line) => line.row));

  ctx.emit(ordersCreated, {
    aggregate: { type: "order", id: orderId },
    payload: {
      orderId,
      customerId,
      totalGrossMinor: moneyToCanonical(totalGrossMinor),
      currency,
      itemCount: items.length,
    },
  });

  return {
    orderId,
    orderNumber: header.orderNumber,
    customer: {
      nameSnapshot: customerNameSnapshot,
      linkedCustomerId: customerId,
    },
    status: "new",
    itemCount: items.length,
    totalNetMinor: moneyToCanonical(totalNetMinor),
    totalTaxMinor: moneyToCanonical(totalTaxMinor),
    totalGrossMinor: moneyToCanonical(totalGrossMinor),
    currency,
    createdAt: header.createdAt.toISOString(),
  };
}
