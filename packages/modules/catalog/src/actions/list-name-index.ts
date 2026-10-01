import { implementAction } from "@showzy/core";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { and, asc, eq } from "drizzle-orm";

import {
  LIST_NAME_INDEX_PRODUCTS_MAX,
  LIST_NAME_INDEX_VARIANTS_MAX,
  listNameIndexContract,
} from "./list-name-index.contract.js";

export const listNameIndex = implementAction(listNameIndexContract, {
  handler: async (_input, ctx) => {
    const productRows = await ctx.db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          eq(products.status, "active"),
        ),
      )
      .orderBy(asc(products.id))
      .limit(LIST_NAME_INDEX_PRODUCTS_MAX + 1);

    const variantRows = await ctx.db
      .select({
        id: productVariants.id,
        productId: productVariants.productId,
        name: productVariants.name,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.companyId, ctx.companyId),
          eq(productVariants.status, "active"),
        ),
      )
      .orderBy(asc(productVariants.id))
      .limit(LIST_NAME_INDEX_VARIANTS_MAX + 1);

    return {
      products: {
        items: productRows.slice(0, LIST_NAME_INDEX_PRODUCTS_MAX),
        truncated: productRows.length > LIST_NAME_INDEX_PRODUCTS_MAX,
      },
      variants: {
        items: variantRows.slice(0, LIST_NAME_INDEX_VARIANTS_MAX),
        truncated: variantRows.length > LIST_NAME_INDEX_VARIANTS_MAX,
      },
    };
  },
});
