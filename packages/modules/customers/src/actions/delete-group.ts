import { implementAction } from "@showzy/core";
import { deleteStaffGroup } from "../services/delete-group.js";
import { groupAuditTarget } from "../services/group-audit-target.js";
import { deleteGroupContract } from "./delete-group.contract.js";

/**
 * Staff confirmationSummary cannot load the group (core.md §7
 * `ConfirmationSummaryEnv` is validated input + company id; no handler
 * `ctx` / tx). Live name and member count would also distinguish missing
 * vs foreign ids on the challenge. The UI already has the group from
 * list/get when it shows the dialog.
 */
export const deleteGroupConfirmationSummary =
  "Delete this customer group. Customers in the group stay and lose the group assignment.";

export const deleteGroup = implementAction(deleteGroupContract, {
  handler: (input, ctx) => {
    return deleteStaffGroup({ ctx, input });
  },
  confirmationSummary: () => deleteGroupConfirmationSummary,
  auditTarget: groupAuditTarget,
});
