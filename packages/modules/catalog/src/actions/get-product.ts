import { implementAction } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import {
  productMedia,
  products,
  productVariants,
} from "@showzy/db/schema/catalog";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, asc, eq } from "drizzle-orm";

import { productStatusSchema } from "../wire.contract.js";
import { getProductContract } from "./get-product.contract.js";

function parseProductStatus(value: string): "active" | "archived" {
  return parseDbEnum(
    productStatusSchema,
    value,
    `catalog row has illegal status "${value}"`,
  );
}

export const getProduct = implementAction(getProductContract, {
  handler: async (input, ctx) => {
    const productRows = await ctx.db
      .select({
        id: products.id,
        name: products.name,
        basePriceMinor: products.basePriceMinor,
        currency: products.currency,
        status: products.status,
        createdAt: products.createdAt,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          eq(products.id, input.productId),
        ),
      )
      .limit(1);

    const product = productRows[0];
    if (product === undefined) {
      throw new NotFoundError();
    }

    const variantRows = await ctx.db
      .select({
        id: productVariants.id,
        name: productVariants.name,
        status: productVariants.status,
        basePriceMinor: productVariants.basePriceMinor,
        currency: productVariants.currency,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.companyId, ctx.companyId),
          eq(productVariants.productId, product.id),
        ),
      )
      .orderBy(asc(productVariants.createdAt), asc(productVariants.id));

    const mediaRows = await ctx.db
      .select({
        fileId: productMedia.fileId,
      })
      .from(productMedia)
      .where(
        and(
          eq(productMedia.companyId, ctx.companyId),
          eq(productMedia.productId, product.id),
        ),
      )
      .orderBy(asc(productMedia.position), asc(productMedia.id));

    return {
      id: product.id,
      name: product.name,
      basePriceMinor: moneyToCanonical(product.basePriceMinor),
      currency: product.currency,
      status: parseProductStatus(product.status),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      variants: variantRows.map((variant) => ({
        id: variant.id,
        name: variant.name,
        status: parseProductStatus(variant.status),
        basePriceMinor:
          variant.basePriceMinor === null
            ? null
            : moneyToCanonical(variant.basePriceMinor),
        currency: variant.currency,
      })),
      imageFileIds: mediaRows.map((row) => row.fileId),
    };
  },
});
