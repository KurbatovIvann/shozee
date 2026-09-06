import { randomUUID } from "node:crypto";

import type { ActionCtx } from "@showzy/core";
import { CoreInvariantError } from "@showzy/core/errors";
import { products, productVariants } from "@showzy/db/schema/catalog";
import { moneyFromCanonical } from "@showzy/module-kit/canonical";
import type { z } from "zod";

import type {
  createProductInputSchema,
  createProductOutputSchema,
} from "../actions/create-product.contract.js";
import { toProductView } from "./product-view.js";
import { requireWritable } from "./writable.js";

type StaffCtx = Extract<ActionCtx, { principal: "staff" }>;
type CreateInput = z.output<typeof createProductInputSchema>;
type ProductView = z.output<typeof createProductOutputSchema>;
type CreateVariantInput = CreateInput["variants"][number];

export async function createStaffProduct(env: {
  readonly ctx: StaffCtx;
  readonly input: CreateInput;
}): Promise<ProductView> {
  const { ctx, input } = env;
  const db = requireWritable(ctx.db);
  const productId = randomUUID();

  await db.insert(products).values({
    id: productId,
    companyId: ctx.companyId,
    name: input.name,
    basePriceMinor: moneyFromCanonical(input.basePriceMinor),
    currency: input.currency,
    createdVia: ctx.channel,
  });

  const insertedVariants: {
    id: string;
    name: string;
    basePriceMinor: bigint | null;
    currency: string | null;
  }[] = [];

  if (input.variants.length > 0) {
    const values = input.variants.map((variant) => {
      const variantId = randomUUID();
      const price = variantPriceFields(variant);
      insertedVariants.push({
        id: variantId,
        name: variant.name,
        basePriceMinor: price.basePriceMinor,
        currency: price.currency,
      });
      return {
        id: variantId,
        companyId: ctx.companyId,
        productId,
        name: variant.name,
        basePriceMinor: price.basePriceMinor,
        currency: price.currency,
        createdVia: ctx.channel,
      };
    });
    await db.insert(productVariants).values(values);
  }

  ctx.log.info(
    { product_id: productId, variant_count: insertedVariants.length },
    "catalog.createProduct created product",
  );

  return toProductView(
    {
      id: productId,
      name: input.name,
      basePriceMinor: moneyFromCanonical(input.basePriceMinor),
      currency: input.currency,
    },
    insertedVariants,
  );
}

function variantPriceFields(variant: CreateVariantInput): {
  basePriceMinor: bigint | null;
  currency: string | null;
} {
  if (variant.basePriceMinor !== undefined && variant.currency !== undefined) {
    return {
      basePriceMinor: moneyFromCanonical(variant.basePriceMinor),
      currency: variant.currency,
    };
  }
  if (variant.basePriceMinor === undefined && variant.currency === undefined) {
    return { basePriceMinor: null, currency: null };
  }
  throw new CoreInvariantError(
    "variant price and currency pairing survived input validation unpaired",
  );
}
