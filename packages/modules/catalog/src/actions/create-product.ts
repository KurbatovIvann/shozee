import { implementAction } from "@showzy/core";
import { createStaffProduct } from "../services/create-product.js";
import { productAuditTarget } from "../services/product-audit-target.js";
import { createProductContract } from "./create-product.contract.js";

export const createProduct = implementAction(createProductContract, {
  handler: (input, ctx) => {
    return createStaffProduct({ ctx, input });
  },
  auditTarget: productAuditTarget,
});
