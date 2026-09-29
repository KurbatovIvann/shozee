import type { ParamType } from "./bundle.ts";
import { valueOf } from "./numbers.ts";
import { isNames, type ParamValue } from "./params.ts";

const LISTED_BY_PERIOD: ReadonlyMap<string, string> = new Map([["orders.get", "orders.list"]]);
const LISTING_PARAMS: ReadonlySet<string> = new Set(["period", "status"]);
const ORDER_NUMBER = "order_number";
const CUSTOMER_TYPE: ParamType = "customer";
const GROUP_MOVE = "customers.setGroup";
const CUSTOMER_UPDATE = "customers.updateCustomer";
const CUSTOMERS_PARAM = "customers";
const CUSTOMER_PARAM = "customer";

export interface Moved {
  readonly action: string;
  readonly params: Record<string, ParamValue>;
}

// D58: a group move of one customer is that customer's update, so the contract has one shape per count: customers.updateCustomer {customer, group} for one,
// customers.setGroup {customers: [...], group} for two or more.
export function singleGroupMove(action: string, params: Readonly<Record<string, ParamValue>>): Moved {
  const customers = params[CUSTOMERS_PARAM];
  const only = isNames(customers) && customers.length === 1 ? customers[0] : undefined;
  if (action !== GROUP_MOVE || only === undefined) return { action, params: { ...params } };
  return { action: CUSTOMER_UPDATE, params: { [CUSTOMER_PARAM]: only, ...Object.fromEntries(Object.entries(params).filter(([name]) => name !== CUSTOMERS_PARAM)) } };
}

export function listedAction(action: string, params: Readonly<Record<string, unknown>>): string {
  const names = Object.keys(params);
  const listed = LISTED_BY_PERIOD.get(action);
  if (listed !== undefined && names.includes("period") && names.every((name) => LISTING_PARAMS.has(name))) return listed;
  return action;
}

export function numberlessOrder(types: Readonly<Record<string, ParamType>>, params: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
  const span = params[ORDER_NUMBER];
  if (typeof span !== "string" || valueOf(ORDER_NUMBER, span) !== null) return { ...params };
  const kept = Object.fromEntries(Object.entries(params).filter(([name]) => name !== ORDER_NUMBER));
  const customer = Object.entries(types).find(([, type]) => type === CUSTOMER_TYPE)?.[0];
  if (customer !== undefined && !Object.hasOwn(kept, customer)) kept[customer] = span;
  return kept;
}
