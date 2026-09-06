/**
 * Staff high-risk contract for SHO-178 (feature SHO-169): hard-delete an
 * archived CRM customer in the active company. Card-named metadata: staff
 * principal, client transport, `customers:delete` (admin seed; manager
 * has edit/archive but not delete), high risk, confirmation, exposed to
 * AI, idempotent, audited, no events. Lifecycle is archive then delete.
 *
 * Mechanical choices copied from `customers.deleteGroup` / catalog writes
 * and core.md §7:
 * - `timeout: 5000` — one delete; order and counterparty unlinks are
 *   ON DELETE SET NULL; personal prices CASCADE.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }` only. Company id is never input.
 * - Output is `{ id }` so the client can drop the row without a second
 *   round-trip.
 * - Deleting an active customer is a validation failure (must archive
 *   first), not NotFound and not a silent archive.
 * - A second delete of a missing id is `NotFoundError`, same as a
 *   foreign-company id (no existence leak). Same-key replay still returns
 *   the stored `{ id }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const deleteCustomerInputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteCustomerOutputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteCustomerContract = defineActionContract({
  name: "customers.deleteCustomer",
  description:
    "Hard-delete an archived CRM customer in the staff member's active company. Active customers must be archived first; deleting an active row fails validation and does not archive. Orders stay and lose the customer link. Linked counterparties stay as standalone legal rows. Personal prices for the customer are removed. Groups are not deleted. Missing customers and customers that belong to another company fail with the same not-found. Company id is never input. Requires confirmation. Re-submitting the identical payload with the same idempotency key after a successful delete returns the stored acknowledgement and does not error.",
  principal: "staff",
  transport: "client",
  input: deleteCustomerInputSchema,
  output: deleteCustomerOutputSchema,
  permissions: ["customers:delete"],
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
