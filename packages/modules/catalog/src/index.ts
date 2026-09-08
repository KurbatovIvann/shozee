import { archiveProduct } from "./actions/archive-product.js";
import { archiveVariant } from "./actions/archive-variant.js";
import { createProduct } from "./actions/create-product.js";
import { createVariant } from "./actions/create-variant.js";
import { getProduct } from "./actions/get-product.js";
import { getProductOrderFacts } from "./actions/get-product-order-facts.js";
import { getProductPricingFacts } from "./actions/get-product-pricing-facts.js";
import { listProducts } from "./actions/list-products.js";
import { resolveLineReferences } from "./actions/resolve-line-references.js";
import { restoreProduct } from "./actions/restore-product.js";
import { restoreVariant } from "./actions/restore-variant.js";
import { searchMatches } from "./actions/search-matches.js";
import { setProductImages } from "./actions/set-product-images.js";
import { updateProduct } from "./actions/update-product.js";
import { updateVariant } from "./actions/update-variant.js";
import { ReferenceResolutionConflictError } from "./services/reference-resolution-conflict.js";

export { archiveProduct };
export { archiveVariant };
export { createProduct };
export { createVariant };
export { getProduct };
export { getProductOrderFacts };
export { getProductPricingFacts };
export { listProducts };
export { resolveLineReferences };
export { ReferenceResolutionConflictError };
export { restoreProduct };
export { restoreVariant };
export { searchMatches };
export { setProductImages };
export { updateProduct };
export { updateVariant };

export const catalogActions = [
  createProduct,
  createVariant,
  getProduct,
  getProductOrderFacts,
  getProductPricingFacts,
  listProducts,
  resolveLineReferences,
  updateProduct,
  updateVariant,
  archiveProduct,
  restoreProduct,
  archiveVariant,
  restoreVariant,
  searchMatches,
  setProductImages,
] as const;
