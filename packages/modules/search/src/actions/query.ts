import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { queryContract } from "./query.contract.js";

export const query = implementAction(queryContract, {
  handler: () =>
    Promise.reject(
      new CoreInvariantError(
        "search.query handler is implemented in SHO-534 (T8)",
      ),
    ),
});
