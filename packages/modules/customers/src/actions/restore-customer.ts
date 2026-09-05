import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { customerAuditTarget } from "../services/customer-audit-target.js";
import { setCustomerStatus } from "../services/customer-status.js";
import { requireWritable } from "../services/writable.js";
import { restoreCustomerContract } from "./restore-customer.contract.js";

export const restoreCustomer = implementAction(restoreCustomerContract, {
  handler: async (input, ctx) => {
    const saved = await setCustomerStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      customerId: input.id,
      status: "active",
    });
    if (saved.status !== "active") {
      throw new CoreInvariantError(
        "customers.restoreCustomer did not leave the customer active",
      );
    }
    return saved;
  },
  auditTarget: customerAuditTarget,
});
