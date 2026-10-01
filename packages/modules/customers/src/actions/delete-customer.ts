import { implementAction } from "@showzy/core";
import { customerAuditTarget } from "../services/customer-audit-target.js";
import {
  ACTIVE_CUSTOMER_DELETE_MESSAGE,
  deleteStaffCustomer,
} from "../services/delete-customer.js";
import { deleteCustomerContract } from "./delete-customer.contract.js";

export { ACTIVE_CUSTOMER_DELETE_MESSAGE };

/**
 * Staff confirmationSummary cannot load the customer (core.md §7
 * `ConfirmationSummaryEnv` is validated input + company id; no handler
 * `ctx` / tx). Live name and contact would also distinguish missing vs
 * foreign ids on the challenge. The UI already has the customer from
 * list/get when it shows the dialog; this copy names those identity
 * fields without echoing their values.
 */
export const deleteCustomerConfirmationSummary =
  "Видалити цього архівованого клієнта. Замовлення залишаться і втратять зв’язок із клієнтом. Прив’язані контрагенти залишаться окремими юридичними особами.";

export const deleteCustomer = implementAction(deleteCustomerContract, {
  handler: (input, ctx) => {
    return deleteStaffCustomer({ ctx, input });
  },
  confirmationSummary: () => deleteCustomerConfirmationSummary,
  auditTarget: customerAuditTarget,
});
