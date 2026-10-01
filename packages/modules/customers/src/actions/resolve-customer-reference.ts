import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import { pickUniqueReferenceMatch } from "@showzy/validation/entity-ref";
import { and, eq } from "drizzle-orm";

import {
  customerCandidateColumns,
  customerCandidateLabel,
  customerCandidateName,
  customerMatchFields,
  loadCustomerReferenceCandidates,
  type CustomerCandidate,
} from "../services/customer-reference-candidates.js";
import {
  CustomerReferenceConflictError,
  ambiguousCustomerQueryMessage,
} from "../services/reference-resolution-conflict.js";
import {
  CUSTOMER_REFERENCE_OPTIONS_MAX,
  resolveCustomerReferenceContract,
} from "./resolve-customer-reference.contract.js";

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

function throwCustomerSelectionConflict(
  query: string,
  rows: readonly CustomerCandidate[],
): never {
  const sorted = [...rows].toSorted(compareCustomerNameThenId);
  throw new CustomerReferenceConflictError({
    target: { kind: "customer", query },
    options: sorted.slice(0, CUSTOMER_REFERENCE_OPTIONS_MAX).map((row) => ({
      id: row.id,
      label: customerCandidateLabel(row),
    })),
    optionsTruncated: sorted.length > CUSTOMER_REFERENCE_OPTIONS_MAX,
    clientMessage: ambiguousCustomerQueryMessage(query),
  });
}

export const resolveCustomerReference = implementAction(
  resolveCustomerReferenceContract,
  {
    handler: async (input, ctx) => {
      if (input.by === "id") {
        const row = (
          await ctx.db
            .select(customerCandidateColumns)
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

      const candidates = await loadCustomerReferenceCandidates({
        db: ctx.db,
        companyId: ctx.companyId,
        query: input.value,
        activeOnly: true,
      });
      const picked = pickUniqueReferenceMatch(
        input.value,
        candidates,
        customerMatchFields,
        customerCandidateName,
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
