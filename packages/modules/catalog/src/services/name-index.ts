import type { ActionCtx } from "@showzy/core";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { and, asc, eq, lte } from "drizzle-orm";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

export type CatalogNameIndexCaps = {
  readonly products: number;
  readonly variants: number;
};

export async function readCatalogNameIndex(args: {
  readonly db: StaffDb;
  readonly companyId: string;
  readonly caps: CatalogNameIndexCaps;
}) {
  const productRows = await args.db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(
      and(
        eq(products.companyId, args.companyId),
        eq(products.status, "active"),
      ),
    )
    .orderBy(asc(products.id))
    .limit(args.caps.products + 1);

  const listedProducts = productRows.slice(0, args.caps.products);
  const productsTruncated = productRows.length > args.caps.products;
  const lastListedProductId = listedProducts.at(-1)?.id;

  const variantRows =
    lastListedProductId === undefined
      ? []
      : await args.db
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            name: productVariants.name,
          })
          .from(productVariants)
          .innerJoin(
            products,
            and(
              eq(products.id, productVariants.productId),
              eq(products.companyId, args.companyId),
              eq(products.status, "active"),
              lte(products.id, lastListedProductId),
            ),
          )
          .where(
            and(
              eq(productVariants.companyId, args.companyId),
              eq(productVariants.status, "active"),
            ),
          )
          .orderBy(asc(productVariants.id))
          .limit(args.caps.variants + 1);

  return {
    products: {
      items: listedProducts,
      truncated: productsTruncated,
    },
    variants: {
      items: variantRows.slice(0, args.caps.variants),
      truncated: productsTruncated || variantRows.length > args.caps.variants,
    },
  };
}
