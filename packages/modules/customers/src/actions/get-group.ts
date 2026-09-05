import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { customerGroups } from "@showzy/db/schema/customers";
import { and, eq } from "drizzle-orm";

import { countActiveGroupMembers } from "../services/count-active-members.js";
import { toGroupView } from "../services/group-view.js";
import { getGroupContract } from "./get-group.contract.js";

export const getGroup = implementAction(getGroupContract, {
  handler: async (input, ctx) => {
    const row = (
      await ctx.db
        .select({
          id: customerGroups.id,
          name: customerGroups.name,
          slug: customerGroups.slug,
          description: customerGroups.description,
          priceListId: customerGroups.priceListId,
          createdAt: customerGroups.createdAt,
          updatedAt: customerGroups.updatedAt,
        })
        .from(customerGroups)
        .where(
          and(
            eq(customerGroups.companyId, ctx.companyId),
            eq(customerGroups.id, input.id),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new NotFoundError();
    }

    const memberCount = await countActiveGroupMembers(
      ctx.db,
      ctx.companyId,
      row.id,
    );
    return toGroupView(row, memberCount);
  },
});
