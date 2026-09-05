import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { variantAuditTarget } from "../services/catalog-audit-target.js";
import { setVariantStatus } from "../services/catalog-status.js";
import { requireWritable } from "../services/writable.js";
import { archiveVariantContract } from "./archive-variant.contract.js";

export const archiveVariant = implementAction(archiveVariantContract, {
  handler: async (input, ctx) => {
    const saved = await setVariantStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      variantId: input.variantId,
      status: "archived",
    });
    if (saved.status !== "archived") {
      throw new CoreInvariantError(
        "catalog.archiveVariant did not leave the variant archived",
      );
    }
    return { variantId: saved.variantId, status: "archived" as const };
  },
  auditTarget: variantAuditTarget,
});
