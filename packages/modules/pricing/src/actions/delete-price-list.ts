import { implementAction } from "@showzy/core";
import { deleteStaffPriceList } from "../services/delete-price-list.js";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { deletePriceListPreview } from "../services/preview-card.js";
import { deletePriceListContract } from "./delete-price-list.contract.js";

export const deletePriceList = implementAction(deletePriceListContract, {
  handler: (input, ctx) => {
    return deleteStaffPriceList({ ctx, input });
  },
  preview: deletePriceListPreview(deletePriceListContract),
  auditTarget: priceListAuditTarget,
});
