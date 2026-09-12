import { implementAction } from "@showzy/core";

import { readStaffActiveTurn } from "../services/turns.js";
import { readActiveTurnContract } from "./read-active-turn.contract.js";

export const readActiveTurn = implementAction(readActiveTurnContract, {
  handler: (input, ctx) =>
    readStaffActiveTurn({ ctx, conversationId: input.conversationId }),
});
