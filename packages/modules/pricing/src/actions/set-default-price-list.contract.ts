/**
 * Staff write contract for SHO-188 (feature SHO-183): set or clear the
 * company default price list. Card-named metadata: staff principal,
 * client transport, `pricing:manage`, write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `pricing.createPriceList` and catalog
 * status-only writes (ADR-0026):
 * - `timeout: 5000` — one execution transaction, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ priceListId: uuid | null }`. Company id is never input.
 * - `null` clears the company default (zero defaults allowed). Non-null
 *   activates the target and unsets the previous default in the same
 *   transaction (`isActive: false` is not accepted here).
 * - Output is the shared `getPriceList` view so the client needs no
 *   second round-trip. Clearing returns that previous list with
 *   `isDefault: false`, or `null` when the company already had zero
 *   defaults.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { getPriceListOutputSchema } from "./get-price-list.contract.js";

export const setDefaultPriceListInputSchema = z.strictObject({
  priceListId: z.uuid().nullable(),
});

export const setDefaultPriceListOutputSchema =
  getPriceListOutputSchema.nullable();

export const setDefaultPriceListContract = defineActionContract({
  name: "pricing.setDefaultPriceList",
  description:
    "Set or clear the default price list in the staff member's active company. A uuid activates that list and unsets the previous company default in the same transaction. Null clears the default and leaves zero defaults; resolution then skips the company-default level. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: setDefaultPriceListInputSchema,
  output: setDefaultPriceListOutputSchema,
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
