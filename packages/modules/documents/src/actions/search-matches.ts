import { getCompany } from "@showzy/companies";
import { implementAction } from "@showzy/core";
import { prepareSearchQuery } from "@showzy/validation/search";

import {
  emptySearchMatchesResult,
  runDocumentsSearchMatches,
} from "../services/search-matches.js";
import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: async (input, ctx) => {
    const prepared = prepareSearchQuery(input.query);
    if (prepared.empty) {
      return emptySearchMatchesResult();
    }
    const company = await ctx.call(getCompany, {});
    return runDocumentsSearchMatches({
      db: ctx.db,
      companyId: ctx.companyId,
      prefix: company.prefix,
      query: input.query,
      limitPerType: input.limitPerType,
    });
  },
});
