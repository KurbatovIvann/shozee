import { toProviderToolName } from "../action-tool.js";

import { CATALOG_GET_PRODUCT_TOOL_NAME } from "./catalog-get-product.js";
import { CATALOG_LIST_PRODUCTS_TOOL_NAME } from "./catalog-list-products.js";
import { CUSTOMERS_GET_CUSTOMER_TOOL_NAME } from "./customers-get-customer.js";
import { CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME } from "./customers-list-customers.js";
import { CUSTOMERS_LIST_GROUPS_TOOL_NAME } from "./customers-list-groups.js";
import { ORDERS_CREATE_TOOL_NAME } from "./orders-create.js";
import {
  ORDERS_LIST_COUNTS_TOOL_NAME,
  ORDERS_LIST_PAGE_TOOL_NAME,
} from "./orders-list.js";
import { PRICING_LIST_PRICE_LISTS_TOOL_NAME } from "./pricing-list-price-lists.js";

export interface StaffAssistantRecordShape {
  readonly rowsKey: string | null;
  readonly idKey: string;
  readonly nameKey: string;
}

const ONE_VIEW: StaffAssistantRecordShape = {
  rowsKey: null,
  idKey: "id",
  nameKey: "name",
};

const PAGE_OF_VIEWS: StaffAssistantRecordShape = {
  rowsKey: "items",
  idKey: "id",
  nameKey: "name",
};

const ONE_ORDER: StaffAssistantRecordShape = {
  rowsKey: null,
  idKey: "orderId",
  nameKey: "orderNumber",
};

export const STAFF_ASSISTANT_CREATE_ACTIONS: readonly string[] = [
  "catalog.createProduct",
  "customers.createCounterparty",
  "customers.createCustomer",
  "customers.createGroup",
  "pricing.createPriceList",
];

const createdViews = (): Record<string, StaffAssistantRecordShape> =>
  Object.fromEntries(
    STAFF_ASSISTANT_CREATE_ACTIONS.map((action) => [
      toProviderToolName(action),
      ONE_VIEW,
    ]),
  );

export const STAFF_ASSISTANT_RECORD_SHAPES: Readonly<
  Record<string, StaffAssistantRecordShape>
> = {
  ...createdViews(),
  [CATALOG_GET_PRODUCT_TOOL_NAME]: ONE_VIEW,
  [CATALOG_LIST_PRODUCTS_TOOL_NAME]: PAGE_OF_VIEWS,
  [CUSTOMERS_GET_CUSTOMER_TOOL_NAME]: ONE_VIEW,
  [CUSTOMERS_LIST_CUSTOMERS_TOOL_NAME]: PAGE_OF_VIEWS,
  [CUSTOMERS_LIST_GROUPS_TOOL_NAME]: PAGE_OF_VIEWS,
  [ORDERS_CREATE_TOOL_NAME]: ONE_ORDER,
  [ORDERS_LIST_PAGE_TOOL_NAME]: { ...ONE_ORDER, rowsKey: "rows" },
  [PRICING_LIST_PRICE_LISTS_TOOL_NAME]: PAGE_OF_VIEWS,
};

export const STAFF_ASSISTANT_RECORDLESS_TOOLS: readonly string[] = [
  ORDERS_LIST_COUNTS_TOOL_NAME,
];
