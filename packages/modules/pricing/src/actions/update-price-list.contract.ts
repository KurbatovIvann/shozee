/**
 * Staff write contract for SHO-186 (feature SHO-183): rename a price
 * list in the active company. Card-named metadata: staff principal,
 * client transport, `pricing:manage`, write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.updateProduct` and create:
 * - `timeout: 5000` — one update, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Name cap matches create / the existing list contract.
 * - Input is name only. `isDefault` / `isActive` are not accepted (those
 *   are dedicated later actions).
 * - Missing or foreign-company lists are not-found (no existence leak).
 * - Output is the same list view as get/create.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { priceListNameSchema } from "./create-price-list.contract.js";
import { getPriceListOutputSchema } from "./get-price-list.contract.js";

export const updatePriceListInputSchema = z.strictObject({
  id: z.uuid(),
  name: priceListNameSchema,
});

export const updatePriceListOutputSchema = getPriceListOutputSchema;

export const updatePriceListContract = defineActionContract({
  name: "pricing.updatePriceList",
  description:
    "Update the name of a price list in the staff member's active company. Default and active flags are not accepted on this action. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updatePriceListInputSchema,
  output: updatePriceListOutputSchema,
  permissions: ["pricing:manage"],
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
