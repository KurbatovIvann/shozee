import { getCompany } from "@showzy/companies";
import { implementAction } from "@showzy/core";
import { prepareSearchQuery } from "@showzy/validation/search";

import {
  emptySearchMatchesResult,
  runOrdersSearchMatches,
} from "../services/search-matches.js";
import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: async (input, ctx) => {
    const prepared = prepareSearchQuery(input.query);
    if (prepared.empty) {
      return emptySearchMatchesResult();
    }
    const company = await ctx.call(getCompany, {});
    return runOrdersSearchMatches({
      db: ctx.db,
      companyId: ctx.companyId,
      prefix: company.prefix,
      query: input.query,
      prepared,
      limitPerType: input.limitPerType,
      customerIds: input.customerIds,
    });
  },
});
