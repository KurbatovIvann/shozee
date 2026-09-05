import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { variantAuditTarget } from "../services/catalog-audit-target.js";
import { setVariantStatus } from "../services/catalog-status.js";
import { requireWritable } from "../services/writable.js";
import { restoreVariantContract } from "./restore-variant.contract.js";

export const restoreVariant = implementAction(restoreVariantContract, {
  handler: async (input, ctx) => {
    const saved = await setVariantStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      variantId: input.variantId,
      status: "active",
    });
    if (saved.status !== "active") {
      throw new CoreInvariantError(
        "catalog.restoreVariant did not leave the variant active",
      );
    }
    return { variantId: saved.variantId, status: "active" as const };
  },
  auditTarget: variantAuditTarget,
});
