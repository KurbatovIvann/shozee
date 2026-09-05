import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, eq } from "drizzle-orm";

import { countPriceListEntries } from "../services/count-price-list-entries.js";
import { getPriceListContract } from "./get-price-list.contract.js";

export const getPriceList = implementAction(getPriceListContract, {
  handler: async (input, ctx) => {
    const row = (
      await ctx.db
        .select({
          id: priceLists.id,
          name: priceLists.name,
          isDefault: priceLists.isDefault,
          isActive: priceLists.isActive,
          createdAt: priceLists.createdAt,
          updatedAt: priceLists.updatedAt,
        })
        .from(priceLists)
        .where(
          and(
            eq(priceLists.companyId, ctx.companyId),
            eq(priceLists.id, input.id),
          ),
        )
        .limit(1)
    )[0];
    if (row === undefined) {
      throw new NotFoundError();
    }

    return {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      isActive: row.isActive,
      entryCount: await countPriceListEntries(ctx.db, ctx.companyId, row.id),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },
});
