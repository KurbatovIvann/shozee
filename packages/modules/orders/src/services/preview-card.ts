import type { ActionPreviewEnv } from "@showzy/core";
import type { ActionPreview } from "@showzy/core/errors";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import {
  formatMoneyMinor,
  formatQuantityMilli,
} from "@showzy/module-kit/money-format";
import { PREVIEW_ABSENT } from "@showzy/module-kit/preview-changes";
import { previewCompanyScope } from "@showzy/module-kit/preview-scope";
import type { z } from "zod";

import type { OrderReferenceInput } from "../actions/order-reference.contract.js";
import type {
  orderPriceSourceSchema,
  orderStatusSchema,
} from "../actions/order-view.contract.js";
import {
  resolveCreateOrderDraft,
  type CreateOrderInput,
} from "./create-draft.js";
import { priceOrderLinesInSingleCurrency } from "./create-order.js";
import { titleSnapshot } from "./line-money.js";
import { loadStaffOrder } from "./load-order.js";
import { normalizeOrderComment } from "./order-comment.js";
import { resolveOrderReference } from "./resolve-order-reference.js";

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

export function orderPreviewCommentLine(
  comment: string | null | undefined,
): PreviewLine {
  return {
    label: ORDER_PREVIEW_COMMENT_LABEL,
    value: normalizeOrderComment(comment) ?? PREVIEW_ABSENT,
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

export async function createOrderPreview(
  input: CreateOrderInput,
  env: ActionPreviewEnv,
): Promise<ActionPreview> {
  const draft = await resolveCreateOrderDraft(env.call, input);
  const { currency, priced } = priceOrderLinesInSingleCurrency(
    draft.items,
    draft.prices,
  );

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

export function orderTransitionPreview(
  contract: { readonly name: string },
  subject: string,
): (
  input: OrderReferenceInput,
  env: ActionPreviewEnv,
) => Promise<ActionPreview> {
  return async (input, env) => {
    const companyId = previewCompanyScope(env.companyId, contract);
    const order = await loadStaffOrder({
      db: env.tx,
      companyId,
      orderId: await resolveOrderReference({
        db: env.tx,
        companyId,
        call: env.call,
        input,
      }),
    });

    const lines: PreviewLine[] = order.items.map((item) =>
      orderPreviewLine({
        title: item.titleSnapshot,
        quantityMilli: item.quantityMilli,
        unitPriceMinor: item.unitPriceMinor,
        grossAmountMinor: item.grossAmountMinor,
        currency: item.currency,
      }),
    );
    lines.push(orderPreviewTotalLine(order.totalGrossMinor, order.currency), {
      label: ORDER_PREVIEW_STATUS_LABEL,
      value: STATUS_LABELS[order.status],
    });

    return {
      title: orderPreviewCustomerTitle(
        `${subject} ${order.orderNumber}`,
        order.customer.nameSnapshot,
      ),
      lines,
      notes: [
        orderPreviewPricesNote(order.items.map((item) => item.priceSource)),
      ],
    };
  };
}
