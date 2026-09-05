import { implementAction } from "@showzy/core";

import { getOrderContract } from "./get.contract.js";
import { loadStaffOrder } from "../services/load-order.js";

export const getOrder = implementAction(getOrderContract, {
  handler: (input, ctx) =>
    loadStaffOrder({
      db: ctx.db,
      companyId: ctx.companyId,
      orderId: input.orderId,
    }),
});
