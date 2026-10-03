import { toProviderToolName } from "../action-tool.js";

import { CATALOG_GET_PRODUCT_TOOL_NAME } from "./catalog-get-product.js";
import { CATALOG_LIST_PRODUCTS_TOOL_NAME } from "./catalog-list-products.js";
import { CUSTOMERS_GET_CUSTOMER_TOOL_NAME } from "./customers-get-customer.js";
import { CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME } from "./customers-list-customers.js";
import { CUSTOMERS_LIST_GROUPS_TOOL_NAME } from "./customers-list-groups.js";
import { ORDERS_CREATE_TOOL_NAME } from "./orders-create.js";
import { ORDERS_LIST_PAGE_TOOL_NAME } from "./orders-list.js";
import { PRICING_LIST_PRICE_LISTS_TOOL_NAME } from "./pricing-list-price-lists.js";

export type StaffAssistantRecordKind =
  "counterparty" | "customer" | "group" | "order" | "price_list" | "product";

export interface StaffAssistantRecordShape {
  readonly kind: StaffAssistantRecordKind;
  readonly rowsKey: string | null;
  readonly idKey: string;
  readonly nameKey: string;
}

const view = (
  kind: StaffAssistantRecordKind,
  idKey = "id",
  nameKey = "name",
): StaffAssistantRecordShape => ({ kind, rowsKey: null, idKey, nameKey });

const page = (
  shape: StaffAssistantRecordShape,
  rowsKey: string,
): StaffAssistantRecordShape => ({ ...shape, rowsKey });

const ORDER = view("order", "orderId", "orderNumber");
const PRODUCT = view("product", "productId");

const CREATED: Readonly<Record<string, StaffAssistantRecordShape>> = {
  "catalog.createProduct": PRODUCT,
  "customers.createCounterparty": view("counterparty"),
  "customers.createCustomer": view("customer"),
  "customers.createGroup": view("group"),
  "pricing.createPriceList": view("price_list"),
};

export const STAFF_ASSISTANT_RECORD_SHAPES: Readonly<
  Record<string, StaffAssistantRecordShape>
> = {
  ...Object.fromEntries(
    Object.entries(CREATED).map(([action, shape]) => [
      toProviderToolName(action),
      shape,
    ]),
  ),
  [CATALOG_GET_PRODUCT_TOOL_NAME]: view("product"),
  [CATALOG_LIST_PRODUCTS_TOOL_NAME]: page(view("product"), "items"),
  [CUSTOMERS_GET_CUSTOMER_TOOL_NAME]: view("customer"),
  [CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]: page(view("customer"), "items"),
  [CUSTOMERS_LIST_GROUPS_TOOL_NAME]: page(view("group"), "items"),
  [ORDERS_CREATE_TOOL_NAME]: ORDER,
  [ORDERS_LIST_PAGE_TOOL_NAME]: page(ORDER, "rows"),
  [PRICING_LIST_PRICE_LISTS_TOOL_NAME]: page(view("price_list"), "items"),
};
