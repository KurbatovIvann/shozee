import type { ActionCtx } from "@showzy/core";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { and, asc, eq } from "drizzle-orm";

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

  const variantRows = await args.db
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
      items: productRows.slice(0, args.caps.products),
      truncated: productRows.length > args.caps.products,
    },
    variants: {
      items: variantRows.slice(0, args.caps.variants),
      truncated: variantRows.length > args.caps.variants,
    },
  };
}
