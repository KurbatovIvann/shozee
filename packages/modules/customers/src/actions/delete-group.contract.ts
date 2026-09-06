/**
 * Staff high-risk contract for SHO-176 (feature SHO-169): hard-delete a
 * customer group in the active company. Card-named metadata: staff
 * principal, client transport, `customers:edit` (v1 group writes; not
 * `customers:delete` / `customers:groups:*`), high risk, confirmation,
 * exposed to AI, idempotent, audited, no events. Groups have no archive.
 *
 * Mechanical choices copied from `customers.createGroup` / catalog writes
 * and core.md §7:
 * - `timeout: 5000` — one delete; member unlink is ON DELETE SET NULL.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }` only. Company id is never input.
 * - Output is `{ id }` so the client can drop the row without a second
 *   round-trip.
 * - A second delete of a missing id is `NotFoundError`, same as a
 *   foreign-company id (no existence leak). Catalog has no hard-delete
 *   golden; this matches `customers.updateGroup` missing/foreign, not
 *   archive-as-no-op (the row is gone). Same-key replay still returns
 *   the stored `{ id }`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const deleteGroupInputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteGroupOutputSchema = z.strictObject({
  id: z.uuid(),
});

export const deleteGroupContract = defineActionContract({
  name: "customers.deleteGroup",
  description:
    "Hard-delete a customer group in the staff member's active company. Customers assigned to the group stay and lose the group assignment (group_id SET NULL). There is no group archive. Missing groups and groups that belong to another company fail with the same not-found. Company id is never input. Requires confirmation. Re-submitting the identical payload with the same idempotency key after a successful delete returns the stored acknowledgement and does not error.",
  principal: "staff",
  transport: "client",
  input: deleteGroupInputSchema,
  output: deleteGroupOutputSchema,
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
