import { implementAction } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  classifyEntityLookupMatch,
  entityLookupPicker,
} from "@showzy/module-kit/entity-lookup";
import { and, eq } from "drizzle-orm";

import {
  customerCandidateColumns,
  customerCandidateName,
  customerCandidateOption,
  customerMatchFields,
  loadCustomerReferenceCandidates,
  type CustomerCandidate,
} from "../services/customer-reference-candidates.js";
import {
  CustomerReferenceConflictError,
  ambiguousCustomerQueryMessage,
} from "../services/reference-resolution-conflict.js";
import { resolveCustomerReferenceContract } from "./resolve-customer-reference.contract.js";

function throwCustomerSelectionConflict(
  query: string,
  rows: readonly CustomerCandidate[],
): never {
  const picker = entityLookupPicker(rows.map(customerCandidateOption));
  throw new CustomerReferenceConflictError({
    target: { kind: "customer", query },
    options: picker.options,
    optionsTruncated: picker.optionsTruncated,
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
      const match = classifyEntityLookupMatch(
        input.value,
        candidates,
        customerMatchFields,
        customerCandidateName,
      );
      if (match.kind === "none") {
        throw new NotFoundError();
      }
      if (match.kind !== "unique") {
        throwCustomerSelectionConflict(input.value, match.rows);
      }

      const name = match.row.name.trim();
      if (name.length === 0) {
        throw new CoreInvariantError(
          "customers.resolveCustomerReference query-path name is empty",
        );
      }
      return { customerId: match.row.id, name };
    },
  },
);
