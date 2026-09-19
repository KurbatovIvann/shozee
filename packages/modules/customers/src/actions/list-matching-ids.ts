import { implementAction } from "@showzy/core";
import { companyCustomers } from "@showzy/db/schema/customers";
import { pickListNameSearch } from "@showzy/module-kit/name-match";
import { and, desc, eq } from "drizzle-orm";

import { customerListSearch } from "../services/customer-list-search.js";
import {
  LIST_MATCHING_IDS_MAX,
  listMatchingIdsContract,
} from "./list-matching-ids.contract.js";

export const listMatchingIds = implementAction(listMatchingIdsContract, {
  handler: async (input, ctx) => {
    const search = customerListSearch(input.query);
    if (search === undefined) {
      return { ids: [], truncated: false };
    }
    const scope = eq(companyCustomers.companyId, ctx.companyId);
    const searchPredicate = await pickListNameSearch(search, async (strict) => {
      const found = await ctx.db
        .select({ id: companyCustomers.id })
        .from(companyCustomers)
        .where(and(scope, strict))
        .limit(1);
      return found.length > 0;
    });

    const rows = await ctx.db
      .select({ id: companyCustomers.id })
      .from(companyCustomers)
      .where(and(scope, searchPredicate))
      .orderBy(desc(companyCustomers.updatedAt), desc(companyCustomers.id))
      .limit(LIST_MATCHING_IDS_MAX + 1);

    const truncated = rows.length > LIST_MATCHING_IDS_MAX;
    const page = truncated ? rows.slice(0, LIST_MATCHING_IDS_MAX) : rows;
    return {
      ids: page.map((row) => row.id),
      truncated,
    };
  },
});
