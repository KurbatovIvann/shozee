import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { searchMatchesContract } from "./search-matches.contract.js";

export const searchMatches = implementAction(searchMatchesContract, {
  handler: () =>
    Promise.reject(
      new CoreInvariantError(
        "pricing.searchMatches handler is implemented in SHO-532 (T6)",
      ),
    ),
});
