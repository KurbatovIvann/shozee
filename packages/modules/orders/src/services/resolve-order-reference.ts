import { getCompany } from "@showzy/companies";
import type { ActionCtx, CtxCall } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { orders } from "@showzy/db/schema/orders";
import {
  entityLookupRefusal,
  type EntityLookupOption,
} from "@showzy/module-kit/entity-lookup";
import { canonicalizeOrderNumberToken } from "@showzy/validation/search";
import { and, asc, eq, like } from "drizzle-orm";

import type { OrderReferenceInput } from "../actions/order-reference.contract.js";

import { orderNumberLeftPrefixPattern } from "./search-matches.js";

export const ORDER_REFERENCE_CANDIDATES_MAX = 20;

type OrderReferenceDb = Pick<
  Extract<ActionCtx, { principal: "staff" }>["db"],
  "select"
>;

type OrderNumberRow = {
  readonly id: string;
  readonly orderNumber: string;
};

function candidateOptions(
  rows: readonly OrderNumberRow[],
): readonly EntityLookupOption[] {
  return rows.map((row) => ({ id: row.id, label: row.orderNumber }));
}

async function loadOrderNumberCandidates(env: {
  readonly db: OrderReferenceDb;
  readonly companyId: string;
  readonly pattern: string;
}): Promise<readonly OrderNumberRow[]> {
  return env.db
    .select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(
      and(
        eq(orders.companyId, env.companyId),
        like(orders.orderNumber, env.pattern),
      ),
    )
    .orderBy(asc(orders.orderNumber), asc(orders.id))
    .limit(ORDER_REFERENCE_CANDIDATES_MAX + 1);
}

export async function orderIdFromNumber(env: {
  readonly db: OrderReferenceDb;
  readonly companyId: string;
  readonly prefix: string;
  readonly orderNumber: string;
}): Promise<string> {
  const target = { kind: "order", query: env.orderNumber } as const;
  const canonical = canonicalizeOrderNumberToken(env.orderNumber, env.prefix);
  const pattern =
    canonical === undefined
      ? undefined
      : orderNumberLeftPrefixPattern(canonical);
  if (canonical === undefined || pattern === undefined) {
    throw entityLookupRefusal(target, "none", []);
  }
  const rows = await loadOrderNumberCandidates({
    db: env.db,
    companyId: env.companyId,
    pattern,
  });
  const exact = rows.filter((row) => row.orderNumber === canonical);
  const only = exact.length === 1 ? exact[0] : undefined;
  if (only !== undefined) {
    return only.id;
  }
  const ambiguous = exact.length > 1 ? exact : rows;
  throw entityLookupRefusal(
    target,
    ambiguous.length === 0 ? "none" : "several",
    candidateOptions(ambiguous),
  );
}

export async function resolveOrderReference(env: {
  readonly db: OrderReferenceDb;
  readonly companyId: string;
  readonly call: CtxCall;
  readonly input: OrderReferenceInput;
}): Promise<string> {
  if (env.input.orderId !== undefined) {
    return env.input.orderId;
  }
  if (env.input.orderNumber === undefined) {
    throw new CoreInvariantError(
      "an order reference carries neither orderId nor orderNumber",
    );
  }
  const company = await env.call(getCompany, {});
  return orderIdFromNumber({
    db: env.db,
    companyId: env.companyId,
    prefix: company.prefix,
    orderNumber: env.input.orderNumber,
  });
}
