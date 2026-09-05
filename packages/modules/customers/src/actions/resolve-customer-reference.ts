import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  candidatesContainingQuery,
  normalizeReferenceQuery,
  pickUniqueNormalizedMatch,
} from "@showzy/validation/entity-ref";
import {
  likeContainsPattern,
  sanitizeLikeLiteral,
} from "@showzy/validation/pagination";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import {
  CustomerReferenceConflictError,
  ambiguousCustomerQueryMessage,
} from "../services/reference-resolution-conflict.js";
import {
  CUSTOMER_REFERENCE_OPTIONS_MAX,
  resolveCustomerReferenceContract,
} from "./resolve-customer-reference.contract.js";

const RESOLVE_CUSTOMER_CANDIDATE_MAX = 100;

type CustomerCandidate = {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
};

const candidateColumns = {
  id: companyCustomers.id,
  name: companyCustomers.name,
  phone: companyCustomers.phone,
  email: companyCustomers.email,
};

function customerMatchFields(
  row: CustomerCandidate,
): readonly (string | null)[] {
  return [row.name, row.phone, row.email];
}

function phoneLastDigits(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) {
    return undefined;
  }
  return digits.slice(-4);
}

function customerConflictLabel(row: CustomerCandidate): string {
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

function compareCustomerNameThenId(
  left: CustomerCandidate,
  right: CustomerCandidate,
): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.id.localeCompare(right.id);
}

function pickerFromCustomers(rows: readonly CustomerCandidate[]): {
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly optionsTruncated: boolean;
} {
  const sorted = [...rows].toSorted(compareCustomerNameThenId);
  return {
    options: sorted.slice(0, CUSTOMER_REFERENCE_OPTIONS_MAX).map((row) => ({
      id: row.id,
      label: customerConflictLabel(row),
    })),
    optionsTruncated: sorted.length > CUSTOMER_REFERENCE_OPTIONS_MAX,
  };
}

function throwCustomerSelectionConflict(
  query: string,
  rows: readonly CustomerCandidate[],
): never {
  const picker = pickerFromCustomers(rows);
  throw new CustomerReferenceConflictError({
    target: { kind: "customer", query },
    options: picker.options,
    optionsTruncated: picker.optionsTruncated,
    clientMessage: ambiguousCustomerQueryMessage(query),
  });
}

function fieldMatch(pattern: string): SQL {
  const clause = or(
    ilike(companyCustomers.name, pattern),
    ilike(companyCustomers.phone, pattern),
    ilike(companyCustomers.email, pattern),
  );
  if (clause === undefined) {
    throw new CoreInvariantError(
      "customers.resolveCustomerReference field match is empty",
    );
  }
  return clause;
}

function mergeCustomerCandidates(
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

export const resolveCustomerReference = implementAction(
  resolveCustomerReferenceContract,
  {
    handler: async (input, ctx) => {
      if (input.by === "id") {
        const row = (
          await ctx.db
            .select(candidateColumns)
            .from(companyCustomers)
            .where(
              and(
                eq(companyCustomers.companyId, ctx.companyId),
                eq(companyCustomers.id, input.id),
              ),
            )
            .limit(1)
        )[0];
        if (row === undefined) {
          throw new NotFoundError();
        }
        const name = row.name.trim();
        if (name.length === 0) {
          throw new CoreInvariantError(
            "customers.resolveCustomerReference id-path name is empty",
          );
        }
        return { customerId: row.id, name };
      }

      const normalized = normalizeReferenceQuery(input.value);
      const exactPattern = sanitizeLikeLiteral(normalized);
      const containsPattern = likeContainsPattern(normalized);
      if (exactPattern === undefined || containsPattern === undefined) {
        throw new NotFoundError();
      }

      const activeInCompany = and(
        eq(companyCustomers.companyId, ctx.companyId),
        eq(companyCustomers.status, "active"),
      );
      const [exactRows, containsRows] = await Promise.all([
        ctx.db
          .select(candidateColumns)
          .from(companyCustomers)
          .where(and(activeInCompany, fieldMatch(exactPattern))),
        ctx.db
          .select(candidateColumns)
          .from(companyCustomers)
          .where(and(activeInCompany, fieldMatch(containsPattern)))
          .orderBy(desc(companyCustomers.updatedAt), desc(companyCustomers.id))
          .limit(RESOLVE_CUSTOMER_CANDIDATE_MAX),
      ]);
      const candidates = mergeCustomerCandidates(exactRows, containsRows);

      const scoped = candidatesContainingQuery(
        input.value,
        candidates,
        customerMatchFields,
      );
      const picked = pickUniqueNormalizedMatch(
        input.value,
        scoped,
        customerMatchFields,
      );
      if (picked.kind === "none") {
        throw new NotFoundError();
      }
      if (picked.kind === "ambiguous") {
        throwCustomerSelectionConflict(input.value, picked.rows);
      }

      const name = picked.row.name.trim();
      if (name.length === 0) {
        throw new CoreInvariantError(
          "customers.resolveCustomerReference query-path name is empty",
        );
      }
      return { customerId: picked.row.id, name };
    },
  },
);
