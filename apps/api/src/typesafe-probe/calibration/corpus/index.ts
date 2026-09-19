import type { CalibrationCase } from "../case.js";
import { CASES as CATALOG_CREATE_PRODUCT } from "./catalog_createProduct.js";
import { CASES as CATALOG_LIST_PRODUCTS } from "./catalog_list_products.js";
import { CASES as CUSTOMERS_CREATE_CUSTOMER } from "./customers_createCustomer.js";
import { CASES as CUSTOMERS_CREATE_GROUP } from "./customers_createGroup.js";
import { CASES as CUSTOMERS_LIST_CUSTOMERS } from "./customers_list_customers.js";
import { CASES as CUSTOMERS_LIST_GROUPS } from "./customers_list_groups.js";
import { CASES as ORDERS_CREATE } from "./orders_create.js";
import { CASES as ORDERS_LIST_COUNTS } from "./orders_list_counts.js";
import { CASES as ORDERS_LIST_PAGE } from "./orders_list_page.js";
import { CASES as OTHER_JOBS } from "./other_jobs.js";
import { CASES as PRICING_CREATE_PRICE_LIST } from "./pricing_createPriceList.js";
import { CASES as PRICING_LIST_PRICE_LISTS } from "./pricing_list_price_lists.js";
import { CASES as TALK } from "./talk.js";

export const CALIBRATION_CASES: readonly CalibrationCase[] = [
  ...ORDERS_LIST_COUNTS,
  ...ORDERS_LIST_PAGE,
  ...CUSTOMERS_LIST_CUSTOMERS,
  ...CUSTOMERS_LIST_GROUPS,
  ...CATALOG_LIST_PRODUCTS,
  ...PRICING_LIST_PRICE_LISTS,
  ...ORDERS_CREATE,
  ...CUSTOMERS_CREATE_CUSTOMER,
  ...CUSTOMERS_CREATE_GROUP,
  ...CATALOG_CREATE_PRODUCT,
  ...PRICING_CREATE_PRICE_LIST,
  ...TALK,
  ...OTHER_JOBS,
];
