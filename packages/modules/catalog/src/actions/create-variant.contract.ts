/**
 * Staff write contract for SHO-133 (feature SHO-130): add a variant to an
 * existing active-company product. Card-named metadata: staff principal,
 * client transport, `products:edit`, write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from catalog-T4 / the golden writes — do not
 * invent a second shape:
 * - `timeout: 5000` — one execution transaction, no nested `ctx.call`
 *   (`files.requestUpload`, `companies.create`).
 * - No `rateLimit` override — staff default 120/min per user
 *   (`orders.create`, `files.requestUpload`).
 * - `name` is trimmed and capped at `PRODUCT_NAME_MAX` (120), same as
 *   `companies.create` / catalog-T4.
 * - Optional override uses the T4 pairing rule: `basePriceMinor` and
 *   `currency` are set together or omitted together. Currency is UAH-only
 *   (db.md §11).
 * - Output is the created variant view so the client has ids without a
 *   second round-trip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  catalogNameSchema,
  currencyCodeSchema,
  nonNegativeMoneyWireSchema,
} from "../wire.contract.js";
import { variantViewSchema } from "./variant-view.contract.js";

export const createVariantInputSchema = z
  .strictObject({
    productId: z.uuid(),
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

export const createVariantOutputSchema = variantViewSchema;

export const createVariantContract = defineActionContract({
  name: "catalog.createVariant",
  description:
    "Add a variant to an existing product in the staff member's active company. Takes the product id, a trimmed name, and an optional base-price override that must include its currency (UAH-only MVP). Missing products and products that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created variant and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createVariantInputSchema,
  output: createVariantOutputSchema,
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
