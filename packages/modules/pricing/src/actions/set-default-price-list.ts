import { implementAction } from "@showzy/core";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { setStaffDefaultPriceList } from "../services/set-default-price-list.js";
import { setDefaultPriceListContract } from "./set-default-price-list.contract.js";

export const setDefaultPriceList = implementAction(
  setDefaultPriceListContract,
  {
    handler: (input, ctx) => {
      return setStaffDefaultPriceList({ ctx, input });
    },
    auditTarget: priceListAuditTarget,
  },
);
