import { implementAction } from "@showzy/core";
import { getOrderCardContract } from "./get-order-card.contract.js";
import { loadStaffOrderCard } from "../services/load-order-card.js";

export const getOrderCard = implementAction(getOrderCardContract, {
  handler: async (input, ctx) => {
    return loadStaffOrderCard({
      db: ctx.db,
      companyId: ctx.companyId,
      orderId: input.orderId,
    });
  },
});
