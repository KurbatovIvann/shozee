import { implementAction } from "@showzy/core";
import { counterpartyAuditTarget } from "../services/counterparty-audit-target.js";
import { deleteStaffCounterparty } from "../services/delete-counterparty.js";
import { deleteCounterpartyContract } from "./delete-counterparty.contract.js";

/**
 * Staff confirmationSummary cannot load the counterparty (core.md §7
 * `ConfirmationSummaryEnv` is validated input + company id; no handler
 * `ctx` / tx). Live name and requisites would also distinguish missing
 * vs foreign ids on the challenge. The UI already has the counterparty
 * from list/get when it shows the dialog.
 */
export const deleteCounterpartyConfirmationSummary =
  "Delete this company counterparty. The linked CRM customer stays.";

export const deleteCounterparty = implementAction(deleteCounterpartyContract, {
  handler: (input, ctx) => {
    return deleteStaffCounterparty({ ctx, input });
  },
  confirmationSummary: () => deleteCounterpartyConfirmationSummary,
  auditTarget: counterpartyAuditTarget,
});
