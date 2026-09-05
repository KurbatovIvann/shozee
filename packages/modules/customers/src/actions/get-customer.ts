import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { companyCustomers } from "@showzy/db/schema/customers";
import { and, eq } from "drizzle-orm";

import { countLinkedCounterparties } from "../services/count-linked-counterparties.js";
import { customerColumns, toCustomerView } from "../services/customer-view.js";
import { getCustomerContract } from "./get-customer.contract.js";

export const getCustomer = implementAction(getCustomerContract, {
  handler: async (input, ctx) => {
    const row = (
      await ctx.db
        .select(customerColumns)
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

    const linked = await countLinkedCounterparties(
      ctx.db,
      ctx.companyId,
      row.id,
    );
    return toCustomerView(row, linked);
  },
});
