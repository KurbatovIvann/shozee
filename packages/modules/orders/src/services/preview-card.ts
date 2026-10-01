import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreview } from "@showzy/core/errors";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { orderItems, orders } from "@showzy/db/schema/orders";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import {
  formatMoneyMinor,
  formatQuantityMilli,
} from "@showzy/module-kit/money-format";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  orderPriceSourceSchema,
  type orderStatusSchema,
} from "../actions/order-view.contract.js";
import {
  resolveCreateOrderDraft,
  type CreateOrderInput,
} from "./create-draft.js";
import { priceOrderLines, requireSingleCurrency } from "./create-order.js";
import { titleSnapshot } from "./line-money.js";
import { parseStatus } from "./parse-status.js";

type PriceSource = z.output<typeof orderPriceSourceSchema>;
type OrderStatus = z.output<typeof orderStatusSchema>;
type PreviewLine = ActionPreview["lines"][number];

const PRICE_SOURCE_LABELS: Readonly<Record<PriceSource, string>> = {
  personal: "персональна ціна",
  customer_price_list: "прайс-лист клієнта",
  group_price_list: "прайс-лист групи",
  default_price_list: "основний прайс-лист",
  base: "базова ціна",
};

const STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  new: "новий",
  confirmed: "підтверджено",
  in_progress: "у роботі",
  done: "виконано",
  canceled: "скасовано",
};

export const ORDER_PREVIEW_TOTAL_LABEL = "Разом";
export const ORDER_PREVIEW_STATUS_LABEL = "Поточний статус";
export const ORDER_PREVIEW_COMMENT_LABEL = "Коментар";
export const ORDER_PREVIEW_EMPTY_VALUE = "—";
export const ORDER_PREVIEW_PRICES_NOTE_PREFIX = "Ціни";

export interface OrderPreviewLineFacts {
  readonly title: string;
  readonly quantityMilli: string;
  readonly unitPriceMinor: string;
  readonly grossAmountMinor: string;
  readonly currency: string;
}

export function orderPreviewLine(facts: OrderPreviewLineFacts): PreviewLine {
  const quantity = formatQuantityMilli(facts.quantityMilli);
  const unit = formatMoneyMinor(facts.unitPriceMinor, facts.currency);
  const gross = formatMoneyMinor(facts.grossAmountMinor, facts.currency);
  return { label: facts.title, value: `${quantity} × ${unit} = ${gross}` };
}

export function orderPreviewTotalLine(
  totalGrossMinor: string,
  currency: string,
): PreviewLine {
  return {
    label: ORDER_PREVIEW_TOTAL_LABEL,
    value: formatMoneyMinor(totalGrossMinor, currency),
  };
}

export function orderPreviewCommentLine(comment: string): PreviewLine {
  const trimmed = comment.trim();
  return {
    label: ORDER_PREVIEW_COMMENT_LABEL,
    value: trimmed.length === 0 ? ORDER_PREVIEW_EMPTY_VALUE : trimmed,
  };
}

export function orderPreviewPricesNote(
  sources: readonly PriceSource[],
): string {
  const labels = [...new Set(sources)].map(
    (source) => PRICE_SOURCE_LABELS[source],
  );
  return `${ORDER_PREVIEW_PRICES_NOTE_PREFIX}: ${labels.join(", ")}`;
}

export function orderPreviewCustomerTitle(
  subject: string,
  customerName: string,
): string {
  return `${subject}: ${customerName}`;
}

function previewCompanyScope(
  companyId: string | null,
  contract: { readonly name: string },
): string {
  if (companyId === null) {
    throw new CoreInvariantError(
      `${contract.name} preview ran without a company scope`,
    );
  }
  return companyId;
}

export async function createOrderPreview(
  input: CreateOrderInput,
  env: ActionPreviewEnv,
): Promise<ActionPreview> {
  const draft = await resolveCreateOrderDraft(env.call, input);
  const priced = priceOrderLines(draft.items, draft.prices);
  const currency = requireSingleCurrency(draft.prices);

  const lines: PreviewLine[] = [];
  const sources: PriceSource[] = [];
  let totalGrossMinor = 0n;

  for (const { item, price, amounts } of priced) {
    totalGrossMinor += amounts.grossAmountMinor;
    sources.push(price.source);
    lines.push(
      orderPreviewLine({
        title: titleSnapshot(item.productName, item.variantName ?? undefined),
        quantityMilli: item.quantityMilli,
        unitPriceMinor: price.unitPriceMinor,
        grossAmountMinor: moneyToCanonical(amounts.grossAmountMinor),
        currency,
      }),
    );
  }
  lines.push(
    orderPreviewTotalLine(moneyToCanonical(totalGrossMinor), currency),
  );
  if (input.comment !== undefined) {
    lines.push(orderPreviewCommentLine(input.comment));
  }

  return {
    title: orderPreviewCustomerTitle(
      "Нове замовлення",
      draft.customerNameSnapshot,
    ),
    lines,
    notes: [orderPreviewPricesNote(sources)],
  };
}

async function loadOrderPreviewFacts(
  env: ActionPreviewEnv,
  contract: { readonly name: string },
  orderId: string,
): Promise<{
  readonly orderNumber: string;
  readonly customerNameSnapshot: string;
  readonly lines: readonly PreviewLine[];
  readonly sources: readonly PriceSource[];
}> {
  const companyId = previewCompanyScope(env.companyId, contract);
  const headerRows = await env.tx
    .select({
      orderNumber: orders.orderNumber,
      customerNameSnapshot: orders.customerNameSnapshot,
      status: orders.status,
      totalGrossMinor: orders.totalGrossMinor,
      currency: orders.currency,
    })
    .from(orders)
    .where(and(eq(orders.companyId, companyId), eq(orders.id, orderId)))
    .limit(1);
  const header = headerRows[0];
  if (header === undefined) {
    throw new NotFoundError();
  }

  const itemRows = await env.tx
    .select({
      titleSnapshot: orderItems.titleSnapshot,
      quantityMilli: orderItems.quantityMilli,
      unitPriceMinor: orderItems.unitPriceMinor,
      grossAmountMinor: orderItems.grossAmountMinor,
      currency: orderItems.currency,
      priceSource: orderItems.priceSource,
      createdAt: orderItems.createdAt,
      id: orderItems.id,
    })
    .from(orderItems)
    .where(
      and(eq(orderItems.companyId, companyId), eq(orderItems.orderId, orderId)),
    )
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id));
  if (itemRows.length === 0) {
    throw new CoreInvariantError(`order ${orderId} has no line snapshots`);
  }

  const lines = itemRows.map((row) =>
    orderPreviewLine({
      title: row.titleSnapshot,
      quantityMilli: moneyToCanonical(row.quantityMilli),
      unitPriceMinor: moneyToCanonical(row.unitPriceMinor),
      grossAmountMinor: moneyToCanonical(row.grossAmountMinor),
      currency: row.currency,
    }),
  );
  lines.push(
    orderPreviewTotalLine(
      moneyToCanonical(header.totalGrossMinor),
      header.currency,
    ),
  );
  const status = parseStatus(header.status);
  lines.push({
    label: ORDER_PREVIEW_STATUS_LABEL,
    value: STATUS_LABELS[status],
  });

  return {
    orderNumber: header.orderNumber,
    customerNameSnapshot: header.customerNameSnapshot,
    lines,
    sources: itemRows.map((row) => {
      const source = row.priceSource ?? "";
      return parseDbEnum(
        orderPriceSourceSchema,
        source,
        `order_items row has illegal price_source "${source}"`,
      );
    }),
  };
}

export function orderTransitionPreview(
  contract: { readonly name: string },
  subject: string,
): (
  input: { readonly orderId: string },
  env: ActionPreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const facts = await loadOrderPreviewFacts(env, contract, input.orderId);
    return {
      title: orderPreviewCustomerTitle(
        `${subject} ${facts.orderNumber}`,
        facts.customerNameSnapshot,
      ),
      lines: facts.lines,
      notes: [orderPreviewPricesNote(facts.sources)],
    };
  };
}
