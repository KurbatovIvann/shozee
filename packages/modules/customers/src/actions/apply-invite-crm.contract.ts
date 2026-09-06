/**
 * Internal customer write for SHO-204 (feature SHO-201): create or enrich
 * the acceptor's CRM row inside `invites.accept`'s transaction. Card-named
 * metadata: customer principal, internal transport, write risk, AI
 * internal, no confirmation, no events, `atomicCallers: ["invites.accept"]`.
 *
 * Mechanical choices copied from chat.upsertOrderCard (internal + write +
 * audit) and the kit customer atomic callee:
 * - `timeout: 5000` — the root (`invites.accept`, 10000) shares remaining
 *   budget, same as other internal writes.
 * - `idempotent: false` — atomic callees own no reservation (ADR-0021);
 *   domain match/enrich is naturally repeatable.
 * - Company comes from inherited customer scope (`resolveTarget` +
 *   `inheritedCompanyId`), never from input as a grant.
 * - Output is `{ customerId, created }` so the root can emit
 *   `invites.accepted` without reading customers tables.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_PHONE_MAX,
  customerAssignmentIdSchema,
  customerEmailSchema,
  customerPhoneSchema,
} from "./customer-view.contract.js";

export { CUSTOMER_EMAIL_MAX, CUSTOMER_NAME_MAX, CUSTOMER_PHONE_MAX };

export const applyInviteCrmInputSchema = z.strictObject({
  groupId: customerAssignmentIdSchema,
  priceListId: customerAssignmentIdSchema,
  name: z.string().trim().max(CUSTOMER_NAME_MAX).nullable().optional(),
  phone: customerPhoneSchema,
  email: customerEmailSchema,
  matchUnlinkedContact: z.boolean(),
});

export const applyInviteCrmOutputSchema = z.strictObject({
  customerId: z.uuid(),
  created: z.boolean(),
});

export const applyInviteCrmContract = defineActionContract({
  name: "customers.applyInviteCrm",
  description:
    "Create or enrich the authenticated acceptor's CRM customer in the invite's company. Matches an existing (company, user) row first, then a personal invite's phone or email against unlinked rows (multiple hits conflict), otherwise inserts. Fills empty group and price-list assignments from the token without overwriting staff-set values, links userId when null, and restores archived rows to active. Company id is never input. Emits nothing. Only invites.accept may invoke this capability.",
  principal: "customer",
  transport: "internal",
  input: applyInviteCrmInputSchema,
  output: applyInviteCrmOutputSchema,
  permissions: [],
  aiExposure: "internal",
  risk: "write",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: ["invites.accept"],
  errors: ["NOT_FOUND"],
  audit: true,
  timeout: 5_000,
});
