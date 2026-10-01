import { implementAction } from "@showzy/core";
import { customerAuditTarget } from "../services/customer-audit-target.js";
import { updateCustomerPreview } from "../services/preview-card.js";
import { updateStaffCustomer } from "../services/update-customer.js";
import { updateCustomerContract } from "./update-customer.contract.js";

export const updateCustomer = implementAction(updateCustomerContract, {
  handler: (input, ctx) => {
    return updateStaffCustomer({ ctx, input });
  },
  preview: updateCustomerPreview(updateCustomerContract),
  auditTarget: customerAuditTarget,
});
