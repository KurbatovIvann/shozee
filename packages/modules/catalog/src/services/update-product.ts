import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { moneyFromCanonical } from "@showzy/module-kit/canonical";
import { keepOmitted } from "@showzy/module-kit/keep-omitted";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  updateProductInputSchema,
  updateProductOutputSchema,
} from "../actions/update-product.contract.js";
import { toProductView } from "./product-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateProductInputSchema>;
type ProductView = z.output<typeof updateProductOutputSchema>;

export async function updateStaffProduct(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<ProductView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const existing = (
    await db
      .select({
        id: products.id,
        name: products.name,
        basePriceMinor: products.basePriceMinor,
        currency: products.currency,
      })
      .from(products)
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          eq(products.id, input.productId),
        ),
      )
      .limit(1)
      .for("update")
  )[0];
  if (existing === undefined) {
    throw new NotFoundError();
  }

  const updated = (
    await db
      .update(products)
      .set({
        name: keepOmitted(input.name, existing.name),
        basePriceMinor:
          input.basePriceMinor === undefined
            ? existing.basePriceMinor
            : moneyFromCanonical(input.basePriceMinor),
        currency: keepOmitted(input.currency, existing.currency),
      })
      .where(
        and(
          eq(products.companyId, ctx.companyId),
          eq(products.id, input.productId),
        ),
      )
      .returning({
        id: products.id,
        name: products.name,
        basePriceMinor: products.basePriceMinor,
        currency: products.currency,
      })
  )[0];
  if (updated === undefined) {
    throw new CoreInvariantError(
      "catalog.updateProduct update returned no row",
    );
  }

  const variantRows = await db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      basePriceMinor: productVariants.basePriceMinor,
      currency: productVariants.currency,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.companyId, ctx.companyId),
        eq(productVariants.productId, updated.id),
      ),
    );

  ctx.log.info(
    { product_id: updated.id, variant_count: variantRows.length },
    "catalog.updateProduct updated product",
  );

  return toProductView(updated, variantRows);
}
