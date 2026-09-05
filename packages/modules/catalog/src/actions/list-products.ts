import { implementAction } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import {
  productMedia,
  products,
  productVariants,
} from "@showzy/db/schema/catalog";
import { moneyToCanonical } from "@showzy/module-kit/canonical";
import { parseDbEnum } from "@showzy/module-kit/parse-db-enum";
import { paginate } from "@showzy/validation/pagination";
import { and, count, desc, eq, inArray, lt, or } from "drizzle-orm";

import { productListSearchPredicate } from "../services/product-list-search.js";
import { productStatusSchema } from "../wire.contract.js";
import {
  formatListProductsCursor,
  listProductsContract,
  parseListProductsCursor,
} from "./list-products.contract.js";

function parseProductStatus(value: string): "active" | "archived" {
  return parseDbEnum(
    productStatusSchema,
    value,
    `products row has illegal status "${value}"`,
  );
}

function compareMediaPosition(
  left: { position: number; id: string },
  right: { position: number; id: string },
): number {
  if (left.position !== right.position) {
    return left.position - right.position;
  }
  if (left.id < right.id) {
    return -1;
  }
  if (left.id > right.id) {
    return 1;
  }
  return 0;
}

export const listProducts = implementAction(listProductsContract, {
  handler: async (input, ctx) => {
    const searchPredicate =
      input.query === undefined
        ? undefined
        : productListSearchPredicate(input.query);
    if (input.query !== undefined && searchPredicate === undefined) {
      return { items: [], nextCursor: null };
    }

    const cursor =
      input.cursor === undefined
        ? undefined
        : parseListProductsCursor(input.cursor);
    if (input.cursor !== undefined && cursor === undefined) {
      throw new CoreInvariantError(
        "listProducts cursor passed validation but failed to parse",
      );
    }

    const cursorPredicate =
      cursor === undefined
        ? undefined
        : or(
            lt(products.createdAt, new Date(cursor.createdAt)),
            and(
              eq(products.createdAt, new Date(cursor.createdAt)),
              lt(products.id, cursor.id),
            ),
          );

    const pageRows = await ctx.db
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
          input.status === "all"
            ? undefined
            : eq(products.status, input.status),
          searchPredicate,
          cursorPredicate,
        ),
      )
      .orderBy(desc(products.createdAt), desc(products.id))
      .limit(input.limit + 1);

    const { page, nextCursor } = paginate(pageRows, input.limit, (last) =>
      formatListProductsCursor(last.createdAt, last.id),
    );

    if (page.length === 0) {
      return { items: [], nextCursor: null };
    }

    const productIds = page.map((row) => row.id);

    const variantCountRows = await ctx.db
      .select({
        productId: productVariants.productId,
        value: count(),
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.companyId, ctx.companyId),
          inArray(productVariants.productId, productIds),
        ),
      )
      .groupBy(productVariants.productId);

    const variantCountByProduct = new Map<string, number>();
    for (const row of variantCountRows) {
      variantCountByProduct.set(row.productId, row.value);
    }

    const mediaRows = await ctx.db
      .select({
        id: productMedia.id,
        productId: productMedia.productId,
        fileId: productMedia.fileId,
        position: productMedia.position,
      })
      .from(productMedia)
      .where(
        and(
          eq(productMedia.companyId, ctx.companyId),
          inArray(productMedia.productId, productIds),
        ),
      );

    const primaryImageByProduct = new Map<string, string>();
    const mediaByProduct = new Map<string, typeof mediaRows>();
    for (const row of mediaRows) {
      const existing = mediaByProduct.get(row.productId);
      if (existing === undefined) {
        mediaByProduct.set(row.productId, [row]);
      } else {
        existing.push(row);
      }
    }
    for (const [productId, rows] of mediaByProduct) {
      const sorted = [...rows].sort(compareMediaPosition);
      const primary = sorted[0];
      if (primary !== undefined) {
        primaryImageByProduct.set(productId, primary.fileId);
      }
    }

    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        basePriceMinor: moneyToCanonical(row.basePriceMinor),
        currency: row.currency,
        status: parseProductStatus(row.status),
        variantCount: variantCountByProduct.get(row.id) ?? 0,
        primaryImageFileId: primaryImageByProduct.get(row.id) ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor,
    };
  },
});
