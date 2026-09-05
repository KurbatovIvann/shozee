import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";

import { productAuditTarget } from "../services/catalog-audit-target.js";
import { setProductStatus } from "../services/catalog-status.js";
import { requireWritable } from "../services/writable.js";
import { archiveProductContract } from "./archive-product.contract.js";

export const archiveProduct = implementAction(archiveProductContract, {
  handler: async (input, ctx) => {
    const saved = await setProductStatus(requireWritable(ctx.db), {
      companyId: ctx.companyId,
      productId: input.productId,
      status: "archived",
    });
    if (saved.status !== "archived") {
      throw new CoreInvariantError(
        "catalog.archiveProduct did not leave the product archived",
      );
    }
    return { productId: saved.productId, status: "archived" as const };
  },
  auditTarget: productAuditTarget,
});
