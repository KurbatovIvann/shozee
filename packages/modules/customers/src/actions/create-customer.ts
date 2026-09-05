import { implementAction } from "@showzy/core";
import { customerAuditTarget } from "../services/customer-audit-target.js";
import { createStaffCustomer } from "../services/create-customer.js";
import { createCustomerContract } from "./create-customer.contract.js";

export const createCustomer = implementAction(createCustomerContract, {
  handler: (input, ctx) => {
    return createStaffCustomer({ ctx, input });
  },
  auditTarget: customerAuditTarget,
});
