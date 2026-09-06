/**
 * Staff write contract for SHO-203 (feature SHO-201): create a customer-entry
 * invite in the active company. Card-named metadata: staff principal, client
 * transport, `customers:invite`, write risk, exposed to AI, no confirmation,
 * idempotent, audited, emits `invites.created`.
 *
 * Mechanical choices copied from customers writes / orders.create:
 * - `timeout: 10000` — nested `customers.getGroup` and
 *   `pricing.getPriceList` (each 5000) share the remaining budget.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `expiresAt` is staff input (ISO timestamptz). Min now+1h, max now+365d.
 * - Personal (`isReusable: false`) stores `max_uses = 1`. Reusable may omit
 *   or null `maxUses` (unlimited) or pass an integer >= 1.
 * - Empty `groupId` / `priceListId` = none on the token. Missing/foreign
 *   assignments fail with the same not-found via `ctx.call`.
 * - Output is the invite view plus plaintext `token` once and an opaque
 *   copyable URL (`showzy:invite/{token}` — not a Universal Link, no public
 *   preview action). The secret is never persisted.
 * - Company id is never input.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  INVITE_EXPIRES_MAX_MS,
  INVITE_EXPIRES_MIN_MS,
  inviteAssignmentIdSchema,
  inviteEmailSchema,
  inviteNameSchema,
  invitePhoneSchema,
  inviteViewSchema,
} from "./invite-view.contract.js";

export const PERSONAL_MAX_USES_MESSAGE = "Personal invites must use maxUses 1.";
export const EXPIRES_AT_RANGE_MESSAGE =
  "expiresAt must be between 1 hour and 365 days from now.";

export const INVITE_COPY_URL_PREFIX = "showzy:invite/";

export function inviteCopyUrl(plaintextToken: string): string {
  return `${INVITE_COPY_URL_PREFIX}${plaintextToken}`;
}

function expiresAtInRange(value: string, nowMs: number): boolean {
  const expiresMs = Date.parse(value);
  if (!Number.isFinite(expiresMs)) {
    return false;
  }
  return (
    expiresMs >= nowMs + INVITE_EXPIRES_MIN_MS &&
    expiresMs <= nowMs + INVITE_EXPIRES_MAX_MS
  );
}

export const createInviteInputSchema = z
  .strictObject({
    isReusable: z.boolean(),
    expiresAt: z.iso.datetime(),
    maxUses: z.number().int().min(1).nullable().optional(),
    groupId: inviteAssignmentIdSchema,
    priceListId: inviteAssignmentIdSchema,
    name: inviteNameSchema,
    phone: invitePhoneSchema,
    email: inviteEmailSchema,
  })
  .superRefine((value, ctx) => {
    if (!expiresAtInRange(value.expiresAt, Date.now())) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: EXPIRES_AT_RANGE_MESSAGE,
      });
    }
    if (
      !value.isReusable &&
      value.maxUses !== undefined &&
      value.maxUses !== 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["maxUses"],
        message: PERSONAL_MAX_USES_MESSAGE,
      });
    }
  });

export const createInviteOutputSchema = inviteViewSchema.extend({
  token: z.string().min(1),
  url: z.string().min(1),
});

export const createInviteContract = defineActionContract({
  name: "invites.create",
  description:
    "Create a customer-entry invite in the staff member's active company. Personal invites store max uses 1; reusable invites may omit max uses (unlimited) or cap them. Optional group and price-list assignments are validated in the same company; missing or foreign ids fail with the same not-found. Optional name, phone, and email seed CRM later and use the same length caps as customers. expiresAt must be between one hour and 365 days from now. Returns the invite view plus the plaintext token once and an opaque copyable URL. The secret is never stored. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created invite including that same one-time token.",
  principal: "staff",
  transport: "client",
  input: createInviteInputSchema,
  output: createInviteOutputSchema,
  permissions: ["customers:invite"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: ["invites.created"],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: true,
  timeout: 10_000,
});
