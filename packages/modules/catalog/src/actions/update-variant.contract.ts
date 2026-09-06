/**
 * Staff write contract for SHO-133 (feature SHO-130): update a variant's
 * name and price-override fields. Card-named metadata: staff principal,
 * client transport, `products:edit`, write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from catalog-T4 / `createVariant`:
 * - `timeout: 5000` — one update, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Name cap, UAH-only currency, and override pairing match
 *   `catalog.createVariant`. Omitted override fields clear the override
 *   (full replace of name + override, same as T4 update requiring every
 *   product field).
 * - `productId` is required so a variant that belongs to a different
 *   product in the same company is the same not-found as missing/foreign
 *   (ticket: product-mismatched variants).
 * - Output is the same variant view as create.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  catalogNameSchema,
  currencyCodeSchema,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";
import { variantViewSchema } from "./variant-view.contract.js";

export const updateVariantInputSchema = z
  .strictObject({
    productId: z.uuid(),
    variantId: z.uuid(),
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

export const updateVariantOutputSchema = variantViewSchema;

export const updateVariantContract = defineActionContract({
  name: "catalog.updateVariant",
  description:
    "Update the name and base-price override of a variant in the staff member's active company. Currency is UAH-only (MVP). The override pair is omitted to clear it and set together to replace it. Missing, foreign-company, or product-mismatched variants fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateVariantInputSchema,
  output: updateVariantOutputSchema,
  permissions: ["products:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
