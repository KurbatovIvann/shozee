/**
 * Golden facts contract for later Executors (SHO-86 / pricing-T2).
 *
 * Mechanical choices the feature card left unnamed — copy them, do not invent
 * a second shape:
 * - `timeout: 5000` is the fixture default. A later `ctx.call` from pricing
 *   shares this remaining budget; raise the *caller's* timeout if the
 *   combined read is tight.
 * - Input is resolve's `items: [{ productId, variantId? }]` (min 1, max 200)
 *   so this action can fail the batch on a foreign or mismatched variant.
 *   Facts still return every variant of each product.
 * - Output is `{ products: [...] }` (unique products, first-seen order), not
 *   per-item. Pricing maps this dictionary back to resolve rows.
 * - Money wire is `@showzy/validation/money` via `wire.contract.ts`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { moneyWireSchema } from "../wire.contract.js";

/** Batch ceiling shared with `pricing.resolveProductPrices` (feature card). */
export const PRODUCT_PRICING_FACTS_MAX_ITEMS = 200;

const productPricingFactsItemSchema = z.object({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
});

export const getProductPricingFactsInputSchema = z.object({
  items: z
    .array(productPricingFactsItemSchema)
    .min(1)
    .max(PRODUCT_PRICING_FACTS_MAX_ITEMS),
});

export const getProductPricingFactsOutputSchema = z.object({
  products: z.array(
    z.object({
      productId: z.uuid(),
      basePriceMinor: moneyWireSchema,
      currency: z.string().length(3),
      variants: z.array(
        z.object({
          variantId: z.uuid(),
          basePriceMinor: moneyWireSchema.nullable(),
          currency: z.string().length(3).nullable(),
        }),
      ),
    }),
  ),
});

export const getProductPricingFactsContract = defineActionContract({
  name: "catalog.getProductPricingFacts",
  description:
    "Return catalog base-price facts for a batch of products in the staff member's active company. Each product includes its base price and every variant (variant id plus a nullable base-price override). The whole batch fails with not-found when any product or named variant is missing, belongs to another product, or is outside the company.",
  principal: "staff",
  transport: "internal",
  input: getProductPricingFactsInputSchema,
  output: getProductPricingFactsOutputSchema,
  permissions: ["products:view"],
  aiExposure: "internal",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
