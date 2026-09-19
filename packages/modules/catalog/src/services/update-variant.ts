import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError, NotFoundError } from "@showzy/core/errors";
import { productVariants } from "@showzy/db/schema/catalog";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type {
  updateVariantInputSchema,
  updateVariantOutputSchema,
} from "../actions/update-variant.contract.js";
import { toVariantView, variantPriceFields } from "./variant-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type UpdateInput = z.output<typeof updateVariantInputSchema>;
type VariantView = z.output<typeof updateVariantOutputSchema>;

export async function updateStaffVariant(env: {
  readonly ctx: StaffCtx;
  readonly input: UpdateInput;
}): Promise<VariantView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const price =
    input.basePriceMinor === undefined
      ? {}
      : variantPriceFields({
          basePriceMinor: input.basePriceMinor ?? undefined,
          currency: input.currency ?? undefined,
        });

  const existing = (
    await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.companyId, ctx.companyId),
          eq(productVariants.id, input.variantId),
          eq(productVariants.productId, input.productId),
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
      .update(productVariants)
      .set({ name: input.name, ...price })
      .where(
        and(
          eq(productVariants.companyId, ctx.companyId),
          eq(productVariants.id, input.variantId),
          eq(productVariants.productId, input.productId),
        ),
      )
      .returning({
        id: productVariants.id,
        productId: productVariants.productId,
        name: productVariants.name,
        basePriceMinor: productVariants.basePriceMinor,
        currency: productVariants.currency,
      })
  )[0];
  if (updated === undefined) {
    throw new CoreInvariantError(
      "catalog.updateVariant update returned no row",
    );
  }

  ctx.log.info(
    { product_id: updated.productId, variant_id: updated.id },
    "catalog.updateVariant updated variant",
  );

  return toVariantView(updated);
}
