import { implementAction } from "@showzy/core";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { setStaffPriceListActive } from "../services/set-price-list-active.js";
import { deactivatePriceListContract } from "./deactivate-price-list.contract.js";

export const deactivatePriceList = implementAction(
  deactivatePriceListContract,
  {
    handler: (input, ctx) => {
      return setStaffPriceListActive({
        ctx,
        id: input.id,
        isActive: false,
      });
    },
    auditTarget: priceListAuditTarget,
  },
);
