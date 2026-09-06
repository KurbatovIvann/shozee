/**
 * Customer write contract for SHO-204 (feature SHO-201): accept a
 * customer-entry invite. Card-named metadata: customer principal, client
 * transport, empty permissions, AI internal (raw token must not become an
 * AI tool), write risk, no confirmation, idempotent, audited,
 * `atomicCalls: ["customers.applyInviteCrm"]`, emits `invites.accepted`.
 *
 * Mechanical choices copied from orders.create / kit customer atomic root:
 * - `timeout: 10000` shares remaining budget with the atomic callee
 *   (`customers.applyInviteCrm`, 5000).
 * - Input is `{ token }` (the secret). Company id is never input; the
 *   typed resolver hashes the token and loads a pending, unexpired,
 *   unexhausted invite (or an exhausted invite this user already redeemed).
 * - Missing / expired / revoked / exhausted / unknown → same NotFoundError.
 * - Output is `{ inviteId, customerId, created }` so the client does not
 *   need a second round-trip. The token is never returned.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

export const acceptInviteInputSchema = z.strictObject({
  token: z.string().min(1),
});

export const acceptInviteOutputSchema = z.strictObject({
  inviteId: z.uuid(),
  customerId: z.uuid(),
  created: z.boolean(),
});

export const acceptInviteContract = defineActionContract({
  name: "invites.accept",
  description:
    "Accept a customer-entry invite for the authenticated user. The token is hashed and looked up globally; a pending unexpired unexhausted invite (or an exhausted invite this user already redeemed) resolves the company. Creates or enriches exactly one CRM row in that company via customers.applyInviteCrm, records a redemption, and increments uses on first accept. Same user plus same token retries return the existing CRM row without a second increment. Expired, revoked, exhausted (other users), and unknown tokens fail with the same not-found. Company id is never input. The plaintext token is never stored, logged, or placed on events.",
  principal: "customer",
  transport: "client",
  input: acceptInviteInputSchema,
  output: acceptInviteOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["invites.accepted"],
  atomicCalls: ["customers.applyInviteCrm"],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 10_000,
});
