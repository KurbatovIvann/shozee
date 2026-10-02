import { productPhotoHref } from "../../catalog/products/shared/product-hrefs";
import {
  counterpartyEditorHref,
  customerEditorHref,
  groupEditorHref,
} from "../../customers/shared/customer-hrefs";
import { orderDetailHref } from "../../orders/shared/order-hrefs";
import { priceListEditorHref } from "../../pricing/shared/price-list-hrefs";

export type AssistantRecordKind =
  | "order"
  | "customer"
  | "customerGroup"
  | "counterparty"
  | "product"
  | "priceList";

export function assistantRecordHref(
  kind: AssistantRecordKind,
  recordId: string,
): string {
  switch (kind) {
    case "order":
      return orderDetailHref(recordId);
    case "customer":
      return customerEditorHref(recordId);
    case "customerGroup":
      return groupEditorHref(recordId);
    case "counterparty":
      return counterpartyEditorHref(recordId);
    case "product":
      return productPhotoHref(recordId);
    case "priceList":
      return priceListEditorHref(recordId);
  }
}

const WRITTEN_RECORD_KINDS: Readonly<Record<string, AssistantRecordKind>> = {
  "orders.create": "order",
  "orders.confirm": "order",
  "orders.start": "order",
  "orders.complete": "order",
  "orders.cancel": "order",
  "customers.createCustomer": "customer",
  "customers.updateCustomer": "customer",
  "customers.archiveCustomer": "customer",
  "customers.restoreCustomer": "customer",
  "customers.createGroup": "customerGroup",
  "customers.updateGroup": "customerGroup",
  "customers.createCounterparty": "counterparty",
  "customers.updateCounterparty": "counterparty",
  "catalog.createProduct": "product",
  "catalog.updateProduct": "product",
  "catalog.archiveProduct": "product",
  "catalog.restoreProduct": "product",
  "pricing.createPriceList": "priceList",
  "pricing.updatePriceList": "priceList",
  "pricing.activatePriceList": "priceList",
  "pricing.deactivatePriceList": "priceList",
  "pricing.setDefaultPriceList": "priceList",
};

export function assistantWrittenRecordKind(
  action: string,
): AssistantRecordKind | null {
  return WRITTEN_RECORD_KINDS[action] ?? null;
}
