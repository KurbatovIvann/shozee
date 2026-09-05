import { implementAction } from "@showzy/core";
import { counterpartyAuditTarget } from "../services/counterparty-audit-target.js";
import { updateStaffCounterparty } from "../services/update-counterparty.js";
import { updateCounterpartyContract } from "./update-counterparty.contract.js";

export const updateCounterparty = implementAction(updateCounterpartyContract, {
  handler: (input, ctx) => {
    return updateStaffCounterparty({ ctx, input });
  },
  auditTarget: counterpartyAuditTarget,
});
