import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import type { EntityLookupOption } from "@showzy/module-kit/entity-lookup";
import { pickListNameSearch } from "@showzy/module-kit/name-match";
import { normalizeReferenceQuery } from "@showzy/validation/entity-ref";
import { sanitizeLikeLiteral } from "@showzy/validation/pagination";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { customerReferenceSearch } from "./customer-list-search.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

const CUSTOMER_CANDIDATE_MAX = 100;

export type CustomerCandidate = {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
};

export const customerCandidateColumns = {
  id: companyCustomers.id,
  name: companyCustomers.name,
  phone: companyCustomers.phone,
  email: companyCustomers.email,
};

export function customerMatchFields(
  row: CustomerCandidate,
): readonly (string | null)[] {
  return [row.name, row.phone, row.email];
}

export function customerCandidateName(row: CustomerCandidate): string {
  return row.name;
}

function phoneLastDigits(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) {
    return undefined;
  }
  return digits.slice(-4);
}

export function customerCandidateLabel(row: CustomerCandidate): string {
  const lastDigits =
    row.phone === null ? undefined : phoneLastDigits(row.phone);
  if (lastDigits !== undefined) {
    return `${row.name} (…${lastDigits})`;
  }
  if (row.email !== null && row.email.length > 0) {
    return `${row.name} (${row.email})`;
  }
  return `${row.name} (${row.id})`;
}

export function customerCandidateOption(
  row: CustomerCandidate,
): EntityLookupOption {
  return { id: row.id, label: customerCandidateLabel(row) };
}

function fieldMatch(pattern: string): SQL {
  const clause = or(
    ilike(companyCustomers.name, pattern),
    ilike(companyCustomers.phone, pattern),
    ilike(companyCustomers.email, pattern),
  );
  if (clause === undefined) {
    throw new CoreInvariantError("customer reference field match is empty");
  }
  return clause;
}

function mergeCandidates(
  primary: readonly CustomerCandidate[],
  extra: readonly CustomerCandidate[],
): CustomerCandidate[] {
  const byId = new Map<string, CustomerCandidate>();
  for (const row of primary) {
    byId.set(row.id, row);
  }
  for (const row of extra) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

export async function loadCustomerReferenceCandidates(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly query: string;
  readonly activeOnly: boolean;
}): Promise<readonly CustomerCandidate[]> {
  const normalized = normalizeReferenceQuery(args.query);
  const exactPattern = sanitizeLikeLiteral(normalized);
  const search = customerReferenceSearch(normalized);
  if (exactPattern === undefined || search === undefined) {
    return [];
  }

  const scope = args.activeOnly
    ? and(
        eq(companyCustomers.companyId, args.companyId),
        eq(companyCustomers.status, "active"),
      )
    : eq(companyCustomers.companyId, args.companyId);

  const nameOrContact = await pickListNameSearch(search, async (strict) => {
    const found = await args.db
      .select({ id: companyCustomers.id })
      .from(companyCustomers)
      .where(and(scope, strict))
      .limit(1);
    return found.length > 0;
  });

  const [exactRows, relaxedRows] = await Promise.all([
    args.db
      .select(customerCandidateColumns)
      .from(companyCustomers)
      .where(and(scope, fieldMatch(exactPattern))),
    args.db
      .select(customerCandidateColumns)
      .from(companyCustomers)
      .where(and(scope, nameOrContact))
      .orderBy(desc(companyCustomers.updatedAt), desc(companyCustomers.id))
      .limit(CUSTOMER_CANDIDATE_MAX),
  ]);
  return mergeCandidates(exactRows, relaxedRows);
}
