import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: () =>
    Promise.reject(
      new CoreInvariantError(
        "customers.searchMatches handler is implemented in SHO-529 (T3)",
      ),
    ),
});
