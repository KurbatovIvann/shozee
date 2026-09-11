import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { listStaleTurns as listStaleTurnRows } from "../services/turns.js";
import { listStaleTurnsContract } from "./list-stale-turns.contract.js";

export const listStaleTurns = implementAction(listStaleTurnsContract, {
  handler: (input, ctx) => {
    if (ctx.scope !== "global") {
      throw new CoreInvariantError(
        "assistant.listStaleTurns expects global system",
      );
    }
    return listStaleTurnRows({ ctx, input });
  },
});
