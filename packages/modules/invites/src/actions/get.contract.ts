/**
 * Staff invite get (SHO-203 / feature SHO-201). Mechanical choices the
 * feature card left unnamed — copy `customers.getCustomer`:
 * - Input is `{ id }`. Missing and foreign-company ids fail with the same
 *   not-found (no existence leak).
 * - Output is the shared invite view with derived status. No token, no
 *   hash, no copy URL.
 * - `timeout: 5000` matches the golden catalog/customer reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { inviteViewSchema } from "./invite-view.contract.js";

export const getInviteInputSchema = z.strictObject({
  id: z.uuid(),
});

export const getInviteOutputSchema = inviteViewSchema;

export const getInviteContract = defineActionContract({
  name: "invites.get",
  description:
    "Return one customer-entry invite in the staff member's active company as the shared invite view (id, reusable flag, max uses, use count, expiry, derived status, optional assignments and identity fields, invited-by, timestamps). Missing invites and invites that belong to another company fail with the same not-found. Never returns the plaintext token, token hash, or copy URL. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: getInviteInputSchema,
  output: getInviteOutputSchema,
  permissions: ["customers:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
