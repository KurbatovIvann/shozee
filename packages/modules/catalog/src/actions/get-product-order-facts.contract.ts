/**
 * Golden order-title facts contract for later Executors (SHO-90 / catalog-T2).
 *
 * Mechanical choices copied from `getProductPricingFacts` — do not invent a
 * second facts shape:
 * - `timeout: 5000` is the fixture default. A later `ctx.call` from orders
 *   shares this remaining budget; raise the *caller's* timeout if the
 *   combined read is tight.
 * - Input is the same batch as pricing facts: `items: [{ productId, variantId? }]`
 *   (min 1, max 200) so this action can fail the batch on a foreign or
 *   mismatched variant. Facts still return every variant of each product.
 * - Output is `{ products: [...] }` (unique products, first-seen order), not
 *   per-item. Orders maps this dictionary back to line titles.
 * - Title snapshot format (`{productName}` or `{productName} · {variantName}`)
 *   belongs to orders-T2, not this action.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

/** Batch ceiling shared with `catalog.getProductPricingFacts` (feature card). */
export const PRODUCT_ORDER_FACTS_MAX_ITEMS = 200;

const productOrderFactsItemSchema = z.object({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
});

export const getProductOrderFactsInputSchema = z.object({
  items: z
    .array(productOrderFactsItemSchema)
    .min(1)
    .max(PRODUCT_ORDER_FACTS_MAX_ITEMS),
});

export const getProductOrderFactsOutputSchema = z.object({
  products: z.array(
    z.object({
      productId: z.uuid(),
      name: z.string(),
      variants: z.array(
        z.object({
          variantId: z.uuid(),
          name: z.string(),
        }),
      ),
    }),
  ),
});

export const getProductOrderFactsContract = defineActionContract({
  name: "catalog.getProductOrderFacts",
  description:
    "Return catalog name facts for a batch of products in the staff member's active company. Each product includes its name and every variant (variant id plus name). The whole batch fails with not-found when any product or named variant is missing, belongs to another product, or is outside the company.",
  principal: "staff",
  transport: "internal",
  input: getProductOrderFactsInputSchema,
  output: getProductOrderFactsOutputSchema,
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
