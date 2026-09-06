/**
 * Staff high-risk contract for SHO-187 (feature SHO-183): hard-delete a
 * price list in the active company. Card-named metadata: staff
 * principal, client transport, `pricing:manage`, high risk, confirmation,
 * exposed to AI, idempotent, audited, no events. There is no archive
 * instead of delete. Deleting the default is allowed and leaves zero
 * defaults.
 *
 * Mechanical choices copied from `customers.deleteGroup` / SHO-186 writes
 * and core.md §7:
 * - `timeout: 5000` — one delete; entries CASCADE; customer/group
 *   `price_list_id` already SET NULL on the schema.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }` only. Company id is never input.
 * - Output is `{ id }` so the client can drop the row without a second
 *   round-trip.
 * - A second delete of a missing id is `NotFoundError`, same as a
 *   foreign-company id (no existence leak). Same-key replay still returns
 *   the stored `{ id }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const deletePriceListInputSchema = z.strictObject({
  id: z.uuid(),
});

export const deletePriceListOutputSchema = z.strictObject({
  id: z.uuid(),
});

export const deletePriceListContract = defineActionContract({
  name: "pricing.deletePriceList",
  description:
    "Hard-delete a price list in the staff member's active company. Entries on the list are removed. Customers and groups assigned to the list stay and lose the assignment (price_list_id SET NULL), so they inherit the next price level. Deleting the company default is allowed and leaves zero defaults. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Requires confirmation. Re-submitting the identical payload with the same idempotency key after a successful delete returns the stored acknowledgement and does not error.",
  principal: "staff",
  transport: "client",
  input: deletePriceListInputSchema,
  output: deletePriceListOutputSchema,
  permissions: ["pricing:manage"],
  aiExposure: "exposed",
  risk: "high",
  requiresConfirmation: true,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
