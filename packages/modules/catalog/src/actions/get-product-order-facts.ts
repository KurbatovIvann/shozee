import { implementAction } from "@showzy/core";
import { loadProductFacts } from "../services/load-product-facts.js";
import { getProductOrderFactsContract } from "./get-product-order-facts.contract.js";

export const getProductOrderFacts = implementAction(
  getProductOrderFactsContract,
  {
    handler: async (input, ctx) => {
      const facts = await loadProductFacts({
        db: ctx.db,
        companyId: ctx.companyId,
        items: input.items,
      });
      return {
        products: facts.map((product) => ({
          productId: product.productId,
          name: product.name,
          variants: product.variants.map((variant) => ({
            variantId: variant.variantId,
            name: variant.name,
          })),
        })),
      };
    },
  },
);
