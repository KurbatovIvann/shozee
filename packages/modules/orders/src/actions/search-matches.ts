import { getCompany } from "@showzy/companies";
import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: async (_input, ctx) => {
    await ctx.call(getCompany, {});
    throw new CoreInvariantError(
      "orders.searchMatches handler is implemented in SHO-531 (T5)",
    );
  },
});
