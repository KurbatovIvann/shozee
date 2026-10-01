import { implementAction, type ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import {
  classifyEntityLookupMatch,
  entityLookupRefusal,
} from "@showzy/module-kit/entity-lookup";
import { and, eq } from "drizzle-orm";

import { countLinkedCounterparties } from "../services/count-linked-counterparties.js";
import {
  customerCandidateName,
  customerCandidateOption,
  customerMatchFields,
  loadCustomerReferenceCandidates,
} from "../services/customer-reference-candidates.js";
import { customerColumns, toCustomerView } from "../services/customer-view.js";
import {
  getCustomerContract,
  type GetCustomerInput,
} from "./get-customer.contract.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

async function customerIdFromQuery(
  db: StaffDb,
  companyId: string,
  query: string,
): Promise<string> {
  const candidates = await loadCustomerReferenceCandidates({
    db,
    companyId,
    query,
    activeOnly: false,
  });
  const match = classifyEntityLookupMatch(
    query,
    candidates,
    customerMatchFields,
    customerCandidateName,
  );
  if (match.kind === "unique") {
    return match.row.id;
  }
  const target = { kind: "customer", query } as const;
  throw entityLookupRefusal(
    target,
    match.kind,
    match.kind === "none" ? [] : match.rows.map(customerCandidateOption),
  );
}

async function lookupCustomerId(
  db: StaffDb,
  companyId: string,
  input: GetCustomerInput,
): Promise<string> {
  if (input.id !== undefined) {
    return input.id;
  }
  if (input.query === undefined) {
    throw new CoreInvariantError(
      "customers.getCustomer input carries neither id nor query",
    );
  }
  return await customerIdFromQuery(db, companyId, input.query);
}

export const getCustomer = implementAction(getCustomerContract, {
  handler: async (input, ctx) => {
    const customerId = await lookupCustomerId(ctx.db, ctx.companyId, input);
    const row = (
      await ctx.db
        .select(customerColumns)
        .from(companyCustomers)
        .where(
          and(
            eq(companyCustomers.companyId, ctx.companyId),
            eq(companyCustomers.id, customerId),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new NotFoundError();
    }

    const linked = await countLinkedCounterparties(
      ctx.db,
      ctx.companyId,
      row.id,
    );
    return toCustomerView(row, linked);
  },
});
