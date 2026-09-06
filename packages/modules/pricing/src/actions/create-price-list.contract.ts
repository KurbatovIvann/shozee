/**
 * Staff write contract for SHO-186 (feature SHO-183): create a named
 * price list in the active company. Card-named metadata: staff
 * principal, client transport, `pricing:manage`, write risk, exposed to
 * AI, no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.createProduct` and the feature
 * card:
 * - `timeout: 5000` — one execution transaction, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `name` is trimmed and capped at `PRICE_LIST_NAME_MAX` (120), same
 *   as the existing list contract and catalog names.
 * - `isDefault` defaults false; `isActive` defaults true. Creating with
 *   `isDefault: true` activates the new list and unsets the previous
 *   default in the same transaction; `isActive: false` is ignored.
 * - Output is the created list view (`getPriceListOutputSchema`) so the
 *   client needs no second round-trip. New lists have `entryCount` 0.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { getPriceListOutputSchema } from "./get-price-list.contract.js";
import { PRICE_LIST_NAME_MAX } from "./list-price-lists.contract.js";

export const priceListNameSchema = z
  .string()
  .trim()
  .min(1, { message: "Name must not be blank." })
  .max(PRICE_LIST_NAME_MAX);

export const createPriceListInputSchema = z.strictObject({
  name: priceListNameSchema,
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

export const createPriceListOutputSchema = getPriceListOutputSchema;

export const createPriceListContract = defineActionContract({
  name: "pricing.createPriceList",
  description:
    "Create a price list in the staff member's active company. Takes a trimmed name (max 120), optional isDefault (default false), and optional isActive (default true). Creating with isDefault true activates the new list and unsets the previous company default in the same transaction; isActive false is ignored in that case. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created list and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createPriceListInputSchema,
  output: createPriceListOutputSchema,
  permissions: ["pricing:manage"],
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
