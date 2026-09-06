/**
 * Staff high-risk contract for SHO-193 (feature SHO-191): hard-delete a
 * company counterparty in the active company. Card-named metadata: staff
 * principal, client transport, `customers:edit` (same as `deleteGroup`;
 * not `customers:delete`), high risk, confirmation, exposed to AI,
 * idempotent, audited, no events. Counterparties have no archive.
 *
 * Mechanical choices copied from `customers.deleteGroup` / catalog writes
 * and core.md §7:
 * - `timeout: 5000` — one delete. There is no documents table yet, so
 *   delete succeeds; later documents work adds ON DELETE RESTRICT.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }` only. Company id is never input.
 * - Output is `{ id }` so the client can drop the row without a second
 *   round-trip.
 * - A second delete of a missing id is `NotFoundError`, same as a
 *   foreign-company id (no existence leak). Same-key replay still
 *   returns the stored `{ id }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const deleteCounterpartyInputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteCounterpartyOutputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteCounterpartyContract = defineActionContract({
  name: "customers.deleteCounterparty",
  description:
    "Hard-delete a company counterparty in the staff member's active company. The linked CRM customer stays. There is no counterparty archive. Missing counterparties and counterparties that belong to another company fail with the same not-found. Company id is never input. Requires confirmation. Re-submitting the identical payload with the same idempotency key after a successful delete returns the stored acknowledgement and does not error.",
  principal: "staff",
  transport: "client",
  input: deleteCounterpartyInputSchema,
  output: deleteCounterpartyOutputSchema,
  permissions: ["customers:edit"],
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
