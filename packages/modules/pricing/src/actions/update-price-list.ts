import { implementAction } from "@showzy/core";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { updateStaffPriceList } from "../services/update-price-list.js";
import { updatePriceListContract } from "./update-price-list.contract.js";

export const updatePriceList = implementAction(updatePriceListContract, {
  handler: (input, ctx) => {
    return updateStaffPriceList({ ctx, input });
  },
  auditTarget: priceListAuditTarget,
});
