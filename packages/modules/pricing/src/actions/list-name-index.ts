import { implementAction } from "@showzy/core";
import { priceLists } from "@showzy/db/schema/pricing";
import { and, asc, eq } from "drizzle-orm";

import {
  LIST_NAME_INDEX_PRICE_LISTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) => {
    const rows = await ctx.db
      .select({ id: priceLists.id, name: priceLists.name })
      .from(priceLists)
      .where(
        and(
          eq(priceLists.companyId, ctx.companyId),
          eq(priceLists.isActive, true),
        ),
      )
      .orderBy(asc(priceLists.id))
      .limit(LIST_NAME_INDEX_PRICE_LISTS_MAX + 1);

    return {
      priceLists: {
        items: rows.slice(0, LIST_NAME_INDEX_PRICE_LISTS_MAX),
        truncated: rows.length > LIST_NAME_INDEX_PRICE_LISTS_MAX,
      },
    };
  },
});
