import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { readTurnForJob as readTurnRow } from "../services/turns.js";
import { readTurnForJobContract } from "./read-turn-for-job.contract.js";

export const readTurnForJob = implementAction(readTurnForJobContract, {
  handler: (input, ctx) => {
    if (ctx.scope !== "tenant") {
      throw new CoreInvariantError(
        "assistant.readTurnForJob expects tenant system",
      );
    }
    return readTurnRow({ ctx, companyId: ctx.companyId, input });
  },
});
