import type { ActionCtx } from "@showzy/core";
import { listMatchingIds } from "@showzy/customers";
import { orders } from "@showzy/db/schema/orders";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { sanitizeLikeLiteral } from "@showzy/validation/pagination";
import { eq, gte, ilike, inArray, lte, or, type SQL } from "drizzle-orm";

import type {
  ListOrdersFilter,
  ListOrdersGrossByCurrency,
} from "../../actions/list.contract.js";

export type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
export type ListFilter = ListOrdersFilter;
export type GrossByCurrency = ListOrdersGrossByCurrency;

export type QueryMatch = {
  readonly predicate: SQL | undefined;
  readonly truncated: boolean;
  readonly empty: boolean;
};

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function toBigint(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.length > 0) {
    return BigInt(value);
  }
  return 0n;
}

export function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value.length > 0) {
    return Number(value);
  }
  return 0;
}

function orderNumberSearchLiteral(literal: string): string | undefined {
  const withoutHash = literal.startsWith("#") ? literal.slice(1) : literal;
  if (withoutHash.length === 0) {
    return undefined;
  }
  return withoutHash;
}

function searchPredicate(
  numberLiteral: string | undefined,
  customerIds: readonly string[],
): SQL | undefined {
  const numberMatch =
    numberLiteral === undefined
      ? undefined
      : ilike(orders.orderNumber, `%${numberLiteral}%`);
  const customerMatch =
    customerIds.length === 0
      ? undefined
      : inArray(orders.customerId, [...customerIds]);
  if (numberMatch !== undefined && customerMatch !== undefined) {
    return or(numberMatch, customerMatch);
  }
  return numberMatch ?? customerMatch;
}

export async function resolveQueryMatch(
  ctx: StaffCtx,
  query: string | undefined,
): Promise<QueryMatch> {
  if (query === undefined) {
    return { predicate: undefined, truncated: false, empty: false };
  }
  const searchLiteral = sanitizeLikeLiteral(query);
  const matching = await ctx.call(listMatchingIds, { query });
  const numberLiteral =
    searchLiteral === undefined
      ? undefined
      : orderNumberSearchLiteral(searchLiteral);
  const predicate = searchPredicate(numberLiteral, matching.ids);
  return {
    predicate,
    truncated: matching.truncated,
    empty: predicate === undefined,
  };
}

export function headerPredicates(
  ctx: StaffCtx,
  filter: ListFilter | undefined,
  queryPredicate: SQL | undefined,
): SQL[] {
  const parts: SQL[] = [eq(orders.companyId, ctx.companyId)];
  if (filter?.statuses !== undefined) {
    parts.push(inArray(orders.status, unique(filter.statuses)));
  }
  if (filter?.customerIds !== undefined) {
    parts.push(inArray(orders.customerId, unique(filter.customerIds)));
  }
  if (filter?.createdFrom !== undefined) {
    parts.push(gte(orders.createdAt, new Date(filter.createdFrom)));
  }
  if (filter?.createdTo !== undefined) {
    parts.push(lte(orders.createdAt, new Date(filter.createdTo)));
  }
  if (queryPredicate !== undefined) {
    parts.push(queryPredicate);
  }
  return parts;
}

export function mergeGross(
  into: Map<string, bigint>,
  currency: string,
  amount: bigint,
): void {
  into.set(currency, (into.get(currency) ?? 0n) + amount);
}

export function grossByCurrencyFromMap(
  amounts: Map<string, bigint>,
): GrossByCurrency[] {
  return [...amounts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({
      currency,
      grossAmountMinor: moneyToCanonical(amount),
    }));
}
