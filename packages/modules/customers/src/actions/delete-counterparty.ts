import { implementAction } from "@showzy/core";
import { counterpartyAuditTarget } from "../services/counterparty-audit-target.js";
import { deleteStaffCounterparty } from "../services/delete-counterparty.js";
import { deleteCounterpartyPreview } from "../services/preview-card.js";
import { deleteCounterpartyContract } from "./delete-counterparty.contract.js";

export const deleteCounterparty = implementAction(deleteCounterpartyContract, {
  handler: (input, ctx) => {
    return deleteStaffCounterparty({ ctx, input });
  },
  preview: deleteCounterpartyPreview(deleteCounterpartyContract),
  auditTarget: counterpartyAuditTarget,
});
