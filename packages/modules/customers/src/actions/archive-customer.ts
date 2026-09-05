import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { customerAuditTarget } from "../services/customer-audit-target.js";
import { setCustomerStatus } from "../services/customer-status.js";
import { requireWritable } from "../services/writable.js";
import { archiveCustomerContract } from "./archive-customer.contract.js";

export const archiveCustomer = implementAction(archiveCustomerContract, {
  handler: async (input, ctx) => {
    const saved = await setCustomerStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      customerId: input.id,
      status: "archived",
    });
    if (saved.status !== "archived") {
      throw new CoreInvariantError(
        "customers.archiveCustomer did not leave the customer archived",
      );
    }
    return saved;
  },
  auditTarget: customerAuditTarget,
});
