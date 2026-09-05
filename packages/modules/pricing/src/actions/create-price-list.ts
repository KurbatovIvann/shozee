import { implementAction } from "@showzy/core";
import { createStaffPriceList } from "../services/create-price-list.js";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { createPriceListContract } from "./create-price-list.contract.js";

export const createPriceList = implementAction(createPriceListContract, {
  handler: (input, ctx) => {
    return createStaffPriceList({ ctx, input });
  },
  auditTarget: priceListAuditTarget,
});
