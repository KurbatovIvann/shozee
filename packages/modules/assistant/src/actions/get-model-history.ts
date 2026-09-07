import { implementAction } from "@showzy/core";
import { getStaffModelHistory } from "../services/get-model-history.js";
import { getModelHistoryContract } from "./get-model-history.contract.js";

export const getModelHistory = implementAction(getModelHistoryContract, {
  handler: async (input, ctx) => {
    return getStaffModelHistory({
      ctx,
      conversationId: input.conversationId,
    });
  },
});
