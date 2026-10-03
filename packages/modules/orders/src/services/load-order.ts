import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  orderDiscountKindSchema,
  orderPriceSourceSchema,
  orderTaxTreatmentSchema,
  orderViewSchema,
} from "../actions/order-view.contract.js";
import { parseStatus } from "./parse-status.js";

type StaffReadDb = Pick<
  Extract<ActionCtx, { principal: "staff" }>["db"],
  "select"
>;
type OrderView = z.output<typeof orderViewSchema>;

function parseDiscountKind(
  value: string,
): z.output<typeof orderDiscountKindSchema> {
  return parseDbEnum(
    orderDiscountKindSchema,
    value,
    `order_items row has illegal discount_kind "${value}"`,
  );
}

function parseTaxTreatment(
  value: string,
): z.output<typeof orderTaxTreatmentSchema> {
  return parseDbEnum(
    orderTaxTreatmentSchema,
    value,
    `order_items row has illegal tax_treatment "${value}"`,
  );
}

function parsePriceSource(
  value: string | null,
): z.output<typeof orderPriceSourceSchema> {
  if (value === null) {
    throw new CoreInvariantError("order_items row is missing price_source");
  }
  return parseDbEnum(
    orderPriceSourceSchema,
    value,
    `order_items row has illegal price_source "${value}"`,
  );
}

export async function loadStaffOrder(env: {
  readonly db: StaffReadDb;
  readonly companyId: string;
  readonly orderId: string;
}): Promise<OrderView> {
  const headerRows = await env.db
    .select()
    .from(orders)
    .where(and(eq(orders.companyId, env.companyId), eq(orders.id, env.orderId)))
    .limit(1);
  const header = headerRows[0];
  if (header === undefined) {
    throw new NotFoundError();
  }

  const lineRows = await env.db
    .select()
    .from(orderItems)
    .where(
      and(
        eq(orderItems.companyId, env.companyId),
        eq(orderItems.orderId, env.orderId),
      ),
    )
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));

  if (lineRows.length === 0) {
    throw new CoreInvariantError(`order ${env.orderId} has no line snapshots`);
  }

  return {
    orderId: header.id,
    orderNumber: header.orderNumber,
    customer: {
      nameSnapshot: header.customerNameSnapshot,
      linkedCustomerId: header.customerId,
    },
    status: parseStatus(header.status),
    comment: header.comment,
    totalNetMinor: moneyToCanonical(header.totalNetMinor),
    totalTaxMinor: moneyToCanonical(header.totalTaxMinor),
    totalGrossMinor: moneyToCanonical(header.totalGrossMinor),
    currency: header.currency,
    confirmedAt:
      header.confirmedAt === null ? null : header.confirmedAt.toISOString(),
    createdAt: header.createdAt.toISOString(),
    items: lineRows.map((row) => ({
      itemId: row.id,
      productId: row.productId,
      variantId: row.variantId,
      titleSnapshot: row.titleSnapshot,
      quantityMilli: moneyToCanonical(row.quantityMilli),
      unitPriceMinor: moneyToCanonical(row.unitPriceMinor),
      discountKind: parseDiscountKind(row.discountKind),
      discountValue: moneyToCanonical(row.discountValue),
      discountAmountMinor: moneyToCanonical(row.discountAmountMinor),
      taxTreatment: parseTaxTreatment(row.taxTreatment),
      taxRateBp: row.taxRateBp,
      taxAmountMinor: moneyToCanonical(row.taxAmountMinor),
      netAmountMinor: moneyToCanonical(row.netAmountMinor),
      grossAmountMinor: moneyToCanonical(row.grossAmountMinor),
      currency: row.currency,
      priceSource: parsePriceSource(row.priceSource),
      personalPriceId: row.personalPriceId,
      priceListId: row.priceListId,
      priceListEntryId: row.priceListEntryId,
      resolverVersion: row.resolverVersion,
    })),
  };
}
