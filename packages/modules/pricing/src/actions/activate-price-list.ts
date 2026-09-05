import { implementAction } from "@showzy/core";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { setStaffPriceListActive } from "../services/set-price-list-active.js";
import { activatePriceListContract } from "./activate-price-list.contract.js";

export const activatePriceList = implementAction(activatePriceListContract, {
  handler: (input, ctx) => {
    return setStaffPriceListActive({
      ctx,
      id: input.id,
      isActive: true,
    });
  },
  auditTarget: priceListAuditTarget,
});
