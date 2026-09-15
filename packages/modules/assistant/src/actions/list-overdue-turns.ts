import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { listOverdueTurnRows } from "../services/turns.js";
import { listOverdueTurnsContract } from "./list-overdue-turns.contract.js";

export const listOverdueTurns = implementAction(listOverdueTurnsContract, {
  handler: (input, ctx) => {
    if (ctx.scope !== "global") {
      throw new CoreInvariantError(
        "assistant.listOverdueTurns expects global system",
      );
    }
    return listOverdueTurnRows({ ctx, input });
  },
});
