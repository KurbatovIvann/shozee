import { implementAction } from "@showzy/core";
import { customerAuditTarget } from "../services/customer-audit-target.js";
import {
  ACTIVE_CUSTOMER_DELETE_MESSAGE,
  deleteStaffCustomer,
} from "../services/delete-customer.js";
import { deleteCustomerPreview } from "../services/preview-card.js";
import { deleteCustomerContract } from "./delete-customer.contract.js";

export { ACTIVE_CUSTOMER_DELETE_MESSAGE };

export const deleteCustomer = implementAction(deleteCustomerContract, {
  handler: (input, ctx) => {
    return deleteStaffCustomer({ ctx, input });
  },
  preview: deleteCustomerPreview(deleteCustomerContract),
  auditTarget: customerAuditTarget,
});
