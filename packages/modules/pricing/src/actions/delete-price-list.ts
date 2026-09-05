import { implementAction } from "@showzy/core";
import { deleteStaffPriceList } from "../services/delete-price-list.js";
import { priceListAuditTarget } from "../services/price-list-audit-target.js";
import { deletePriceListContract } from "./delete-price-list.contract.js";

/**
 * Staff confirmationSummary cannot load the list (core.md §7
 * `ConfirmationSummaryEnv` is validated input + company id; no handler
 * `ctx` / tx). Live name would also distinguish missing vs foreign ids on
 * the challenge. The UI already has the list from get/list when it shows
 * the dialog.
 */
export const deletePriceListConfirmationSummary =
  "Delete this price list. Its entries are removed. Assigned customers and groups inherit the next price level.";

export const deletePriceList = implementAction(deletePriceListContract, {
  handler: (input, ctx) => {
    return deleteStaffPriceList({ ctx, input });
  },
  confirmationSummary: () => deletePriceListConfirmationSummary,
  auditTarget: priceListAuditTarget,
});
