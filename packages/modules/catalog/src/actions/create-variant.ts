import { implementAction } from "@showzy/core";
import { createStaffVariant } from "../services/create-variant.js";
import { variantAuditTarget } from "../services/variant-audit-target.js";
import { createVariantContract } from "./create-variant.contract.js";

export const createVariant = implementAction(createVariantContract, {
  handler: (input, ctx) => {
    return createStaffVariant({ ctx, input });
  },
  auditTarget: variantAuditTarget,
});
