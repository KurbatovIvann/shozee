import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { companyCustomerInvites } from "@showzy/db/schema/invites";
import { and, eq } from "drizzle-orm";

import { inviteRowColumns, toInviteView } from "../services/invite-view.js";
import { getInviteContract } from "./get.contract.js";

export const getInvite = implementAction(getInviteContract, {
  handler: async (input, ctx) => {
    const row = (
      await ctx.db
        .select(inviteRowColumns)
        .from(companyCustomerInvites)
        .where(
          and(
            eq(companyCustomerInvites.companyId, ctx.companyId),
            eq(companyCustomerInvites.id, input.id),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new NotFoundError();
    }

    return toInviteView(row);
  },
});
