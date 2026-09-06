/**
 * Staff write contract for SHO-132 (feature SHO-130): create a product and
 * optional initial variants in one transaction. Card-named metadata: staff
 * principal, client transport, `products:create`, write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from the golden writes — do not invent a second
 * shape:
 * - `timeout: 5000` — one execution transaction, no nested `ctx.call`
 *   (`files.requestUpload`, `companies.create`).
 * - No `rateLimit` override — staff default 120/min per user
 *   (`orders.create`, `files.requestUpload`).
 * - `name` is trimmed and capped at `PRODUCT_NAME_MAX` (120), same as
 *   `companies.create`.
 * - `basePriceMinor` is a canonical non-negative int64 money wire string;
 *   optional `currency` is UAH-only (db.md §11) and defaults to UAH.
 * - Initial variants cap 100, same ceiling as `orders.create` line items.
 * - Output is the created product view so the client has ids without a
 *   second round-trip.
 */
import { defineActionContract } from "@showzy/core/contract";
import {
  CREATE_PRODUCT_MAX_VARIANTS,
  DEFAULT_PRODUCT_CURRENCY,
  catalogNameSchema,
  currencyCodeSchema,
} from "@showzy/validation/catalog";
import { z } from "zod";

import { nonNegativeMoneyWireSchema } from "../wire.contract.js";
import { productViewSchema } from "./product-view.contract.js";

export { CREATE_PRODUCT_MAX_VARIANTS };

export const createProductVariantInputSchema = z
  .strictObject({
    name: catalogNameSchema,
    basePriceMinor: nonNegativeMoneyWireSchema.optional(),
    currency: currencyCodeSchema.optional(),
  })
  .refine(
    (variant) =>
      (variant.basePriceMinor === undefined) ===
      (variant.currency === undefined),
    { message: "Variant price and currency must be set together." },
  );

export const createProductInputSchema = z.strictObject({
  name: catalogNameSchema,
  basePriceMinor: nonNegativeMoneyWireSchema,
  currency: currencyCodeSchema.default(DEFAULT_PRODUCT_CURRENCY),
  variants: z
    .array(createProductVariantInputSchema)
    .max(CREATE_PRODUCT_MAX_VARIANTS)
    .default([]),
});

export const createProductOutputSchema = productViewSchema;

export const createProductContract = defineActionContract({
  name: "catalog.createProduct",
  description:
    "Create a product in the staff member's active company, optionally with an initial set of variants, in one transaction. Takes a trimmed name, a non-negative base price in minor units, optional currency UAH (default UAH; MVP is UAH-only), and optional variants (name plus an optional price override that must include its currency). Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created product and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createProductInputSchema,
  output: createProductOutputSchema,
  permissions: ["products:create"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: true,
  timeout: 5_000,
});
