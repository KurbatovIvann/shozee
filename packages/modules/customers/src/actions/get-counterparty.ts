import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { counterparties } from "@showzy/db/schema/customers";
import { and, eq } from "drizzle-orm";

import {
  counterpartyReturning,
  customerNamesByIds,
  toCounterpartyView,
} from "../services/counterparty-view.js";
import { getCounterpartyContract } from "./get-counterparty.contract.js";

export const getCounterparty = implementAction(getCounterpartyContract, {
  handler: async (input, ctx) => {
    const row = (
      await ctx.db
        .select(counterpartyReturning)
        .from(counterparties)
        .where(
          and(
            eq(counterparties.companyId, ctx.companyId),
            eq(counterparties.id, input.id),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new NotFoundError();
    }

    const names =
      row.customerId === null
        ? new Map<string, string>()
        : await customerNamesByIds(ctx.db, ctx.companyId, [row.customerId]);
    return toCounterpartyView(
      row,
      row.customerId === null ? null : (names.get(row.customerId) ?? null),
    );
  },
});
