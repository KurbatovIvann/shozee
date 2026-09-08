import { implementAction } from "@showzy/core";
import { prepareSearchQuery } from "@showzy/validation/search";

import {
  emptySearchMatchesResult,
  runPricingSearchMatches,
} from "../services/search-matches.js";
import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: async (input, ctx) => {
    const prepared = prepareSearchQuery(input.query);
    if (prepared.empty) {
      return emptySearchMatchesResult();
    }
    return runPricingSearchMatches({
      db: ctx.db,
      companyId: ctx.companyId,
      prepared,
      limitPerType: input.limitPerType,
    });
  },
});
