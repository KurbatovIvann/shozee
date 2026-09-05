import { implementAction } from "@showzy/core";
import { productAuditTarget } from "../services/product-audit-target.js";
import { updateStaffProduct } from "../services/update-product.js";
import { updateProductContract } from "./update-product.contract.js";

export const updateProduct = implementAction(updateProductContract, {
  handler: (input, ctx) => {
    return updateStaffProduct({ ctx, input });
  },
  auditTarget: productAuditTarget,
});
