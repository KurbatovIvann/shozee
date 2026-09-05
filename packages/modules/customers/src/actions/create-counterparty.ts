import { implementAction } from "@showzy/core";
import { counterpartyAuditTarget } from "../services/counterparty-audit-target.js";
import { createStaffCounterparty } from "../services/create-counterparty.js";
import { createCounterpartyContract } from "./create-counterparty.contract.js";

export const createCounterparty = implementAction(createCounterpartyContract, {
  handler: (input, ctx) => {
    return createStaffCounterparty({ ctx, input });
  },
  auditTarget: counterpartyAuditTarget,
});
