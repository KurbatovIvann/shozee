import { implementAction } from "@showzy/core";

import { readStaffLatestInterruptedTurn } from "../services/turns.js";
import { readLatestInterruptedTurnContract } from "./read-latest-interrupted-turn.contract.js";

export const readLatestInterruptedTurn = implementAction(
  readLatestInterruptedTurnContract,
  {
    handler: (input, ctx) =>
      readStaffLatestInterruptedTurn({
        ctx,
        conversationId: input.conversationId,
      }),
  },
);
