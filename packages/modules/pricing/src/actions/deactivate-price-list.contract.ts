/**
 * Staff write contract for SHO-188 (feature SHO-183): deactivate a
 * price list. Card-named metadata: staff principal, client transport,
 * `pricing:manage`, write risk, exposed to AI, no confirmation,
 * idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.archiveProduct` (ADR-0026
 * status-only: one column, no confirmation, no events) and SHO-186
 * writes:
 * - `timeout: 5000` — one update, no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }`. Company id is never input.
 * - Already-inactive is a no-op. Deactivating the current default fails
 *   validation and does not unset default; the list stays default and
 *   active.
 * - Output is the shared `getPriceList` view so the client needs no
 *   second round-trip after the flip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { getPriceListOutputSchema } from "./get-price-list.contract.js";

export const deactivatePriceListInputSchema = z.strictObject({
  id: z.uuid(),
});

export const deactivatePriceListOutputSchema = getPriceListOutputSchema;

export const deactivatePriceListContract = defineActionContract({
  name: "pricing.deactivatePriceList",
  description:
    "Deactivate a price list in the staff member's active company. This is a status-only write: no other list columns change. A list that is already inactive is returned unchanged. The current default list cannot be deactivated — the write fails validation and the list stays default and active. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: deactivatePriceListInputSchema,
  output: deactivatePriceListOutputSchema,
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
