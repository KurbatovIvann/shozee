/**
 * Staff write contract for SHO-203 (feature SHO-201): revoke a customer-entry
 * invite. Card-named metadata: staff principal, client transport,
 * `customers:invite`, write risk, exposed to AI, no confirmation,
 * idempotent, audited, emits `invites.revoked`.
 *
 * Already-revoked is a no-op (same view, no second event). Missing and
 * foreign ids fail with the same not-found. No token / hash on output.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { inviteViewSchema } from "./invite-view.contract.js";

export const revokeInviteInputSchema = z.strictObject({
  id: z.uuid(),
});

export const revokeInviteOutputSchema = inviteViewSchema;

export const revokeInviteContract = defineActionContract({
  name: "invites.revoke",
  description:
    "Revoke a customer-entry invite in the staff member's active company. Already-revoked invites are a no-op and return the current view without emitting a second event. Missing invites and invites that belong to another company fail with the same not-found. Never returns the plaintext token or token hash. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-revoked view.",
  principal: "staff",
  transport: "client",
  input: revokeInviteInputSchema,
  output: revokeInviteOutputSchema,
  permissions: ["customers:invite"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["invites.revoked"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
