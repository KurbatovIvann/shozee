/**
 * Staff write contract for SHO-132 (feature SHO-130): update an
 * active-company product's name and base price. Card-named metadata: staff
 * principal, client transport, `products:edit`, write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from the golden writes and `createProduct`:
 * - `timeout: 5000` — one update, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Name cap and money wire shape match `catalog.createProduct`.
 * - Missing or foreign-company products are not-found (no existence leak).
 * - Output is the same product view as create (including unchanged variants).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  catalogNameSchema,
  currencyCodeSchema,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";
import { productViewSchema } from "./product-view.contract.js";

export const updateProductInputSchema = z.strictObject({
  productId: z.uuid(),
  name: catalogNameSchema,
  basePriceMinor: nonNegativeMoneyWireSchema,
  currency: currencyCodeSchema,
});

export const updateProductOutputSchema = productViewSchema;

export const updateProductContract = defineActionContract({
  name: "catalog.updateProduct",
  description:
    "Update the name and base price of a product in the staff member's active company. Currency is UAH-only (MVP). Missing products and products that belong to another company fail with the same not-found. Company id is never input. Variants are not changed. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateProductInputSchema,
  output: updateProductOutputSchema,
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
