import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { NotFoundError } from "@showzy/core/errors";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  createVariantInputSchema,
  createVariantOutputSchema,
} from "../actions/create-variant.contract.js";
import { toVariantView, variantPriceFields } from "./variant-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createVariantInputSchema>;
type VariantView = z.output<typeof createVariantOutputSchema>;

export async function createStaffVariant(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<VariantView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);

  const product = (
    await db
      .select({ id: products.id })
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
  if (product === undefined) {
    throw new NotFoundError();
  }

  const variantId = randomUUID();
  const price = variantPriceFields(input);
  await db.insert(productVariants).values({
    id: variantId,
    companyId: ctx.companyId,
    productId: product.id,
    name: input.name,
    basePriceMinor: price.basePriceMinor,
    currency: price.currency,
    createdVia: ctx.channel,
  });

  ctx.log.info(
    { product_id: product.id, variant_id: variantId },
    "catalog.createVariant created variant",
  );

  return toVariantView({
    id: variantId,
    productId: product.id,
    name: input.name,
    basePriceMinor: price.basePriceMinor,
    currency: price.currency,
  });
}
