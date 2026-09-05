import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { productAuditTarget } from "../services/catalog-audit-target.js";
import { setProductStatus } from "../services/catalog-status.js";
import { requireWritable } from "../services/writable.js";
import { restoreProductContract } from "./restore-product.contract.js";

export const restoreProduct = implementAction(restoreProductContract, {
  handler: async (input, ctx) => {
    const saved = await setProductStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      productId: input.productId,
      status: "active",
    });
    if (saved.status !== "active") {
      throw new CoreInvariantError(
        "catalog.restoreProduct did not leave the product active",
      );
    }
    return { productId: saved.productId, status: "active" as const };
  },
  auditTarget: productAuditTarget,
});
