import { implementAction } from "@showzy/core";
import { customerAuditTarget } from "../services/customer-audit-target.js";
import { createStaffCustomer } from "../services/create-customer.js";
import { createCustomerPreview } from "../services/preview-card.js";
import { createCustomerContract } from "./create-customer.contract.js";

export const createCustomer = implementAction(createCustomerContract, {
  handler: (input, ctx) => {
    return createStaffCustomer({ ctx, input });
  },
  preview: createCustomerPreview(createCustomerContract),
  auditTarget: customerAuditTarget,
});
