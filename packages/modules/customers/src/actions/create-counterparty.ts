import { implementAction } from "@showzy/core";
import { counterpartyAuditTarget } from "../services/counterparty-audit-target.js";
import { createStaffCounterparty } from "../services/create-counterparty.js";
import { createCounterpartyPreview } from "../services/preview-card.js";
import { createCounterpartyContract } from "./create-counterparty.contract.js";

export const createCounterparty = implementAction(createCounterpartyContract, {
  handler: (input, ctx) => {
    return createStaffCounterparty({ ctx, input });
  },
  preview: createCounterpartyPreview(createCounterpartyContract),
  auditTarget: counterpartyAuditTarget,
});
