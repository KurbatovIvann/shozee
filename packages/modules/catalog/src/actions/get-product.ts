import { implementAction, type ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import {
  productMedia,
  products,
  productVariants,
} from "@showzy/db/schema/catalog";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import {
  classifyEntityLookupMatch,
  entityLookupRefusal,
} from "@showzy/module-kit/entity-lookup";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { and, asc, eq } from "drizzle-orm";

import {
  loadProductReferenceCandidates,
  productCandidateName,
  productCandidateOptions,
  productMatchFields,
} from "../services/product-reference-candidates.js";
import { productStatusSchema } from "../wire.contract.js";
import {
  getProductContract,
  type GetProductInput,
} from "./get-product.contract.js";

type StaffDb = Extract<ActionCtx, { principal: "staff" }>["db"];

function parseProductStatus(value: string): "active" | "archived" {
  return parseDbEnum(
    productStatusSchema,
    value,
    `catalog row has illegal status "${value}"`,
  );
}

async function productIdFromQuery(
  db: StaffDb,
  companyId: string,
  query: string,
): Promise<string> {
  const candidates = await loadProductReferenceCandidates({
    db,
    companyId,
    query,
  });
  const match = classifyEntityLookupMatch(
    query,
    candidates,
    productMatchFields,
    productCandidateName,
  );
  if (match.kind === "unique") {
    return match.row.id;
  }
  const target = { kind: "product", query } as const;
  throw entityLookupRefusal(
    target,
    match.kind,
    match.kind === "none" ? [] : productCandidateOptions(match.rows),
  );
}

async function lookupProductId(
  db: StaffDb,
  companyId: string,
  input: GetProductInput,
): Promise<string> {
  if (input.productId !== undefined) {
    return input.productId;
  }
  if (input.productQuery === undefined) {
    throw new CoreInvariantError(
      "catalog.getProduct input carries neither productId nor productQuery",
    );
  }
  return await productIdFromQuery(db, companyId, input.productQuery);
}

export const getProduct = implementAction(getProductContract, {
  handler: async (input, ctx) => {
    const requestedId = await lookupProductId(ctx.db, ctx.companyId, input);
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
          eq(products.id, requestedId),
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
