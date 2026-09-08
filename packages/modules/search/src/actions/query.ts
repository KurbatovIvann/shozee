import { implementAction } from "@showzy/core";

import { executeSearchQuery } from "../services/query.js";
import { queryContract } from "./query.contract.js";

export const query = implementAction(queryContract, {
  handler: (input, ctx) =>
    executeSearchQuery(input, {
      membership: ctx.membership,
      call: ctx.call,
    }),
});
