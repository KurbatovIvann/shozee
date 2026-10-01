import { implementAction } from "@showzy/core";
import { updateVariantPreview } from "../services/preview-card.js";
import { updateStaffVariant } from "../services/update-variant.js";
import { variantAuditTarget } from "../services/variant-audit-target.js";
import { updateVariantContract } from "./update-variant.contract.js";

export const updateVariant = implementAction(updateVariantContract, {
  handler: (input, ctx) => {
    return updateStaffVariant({ ctx, input });
  },
  preview: updateVariantPreview(updateVariantContract),
  auditTarget: variantAuditTarget,
});
