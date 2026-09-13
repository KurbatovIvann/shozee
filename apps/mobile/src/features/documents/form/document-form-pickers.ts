/**
 * Order / counterparty picker labels (SHO-238). Totals are the order
 * list snapshot — do not reprice on the client. Customer name is the
 * primary order label; a linked legal face is a subtitle when it
 * differs from the CRM snapshot.
 */
import { formatMoneyMinor } from "../../../format/money";
import type { DocumentOrderListItem } from "../api/order-list-query";

/** Sentinel persisted on unlinked headers; matches `orders.list`. */
export const UNLINKED_CUSTOMER_NAME_SNAPSHOT = "unlinked";

export function documentOrderOptionName(
  order: DocumentOrderListItem,
  missingCustomer: string,
): string {
  if (order.customer.nameSnapshot === UNLINKED_CUSTOMER_NAME_SNAPSHOT) {
    return missingCustomer;
  }
  return order.customer.nameSnapshot;
}

export function documentOrderOptionDescription(
  order: DocumentOrderListItem,
): string {
  const total = formatMoneyMinor(order.totalGrossMinor, order.currency);
  return `#${order.orderNumber} · ${total}`;
}

export function documentCounterpartyOptionDescription(row: {
  readonly edrpou: string | null;
}): string | null {
  if (row.edrpou === null || row.edrpou.length === 0) {
    return null;
  }
  return row.edrpou;
}

export function counterpartyPickerEnabled(args: {
  readonly orderId: string;
  readonly customerId: string | null;
}): boolean {
  return args.orderId.length > 0 && args.customerId !== null;
}
