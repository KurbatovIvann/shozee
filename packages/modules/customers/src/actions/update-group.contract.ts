/**
 * Staff write contract for SHO-172 (feature SHO-169): update a customer
 * group in the active company. Card-named metadata: staff principal,
 * client transport, `customers:edit` (same as create; not
 * `customers:delete` / `customers:groups:*`), write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.updateProduct` and createGroup:
 * - `timeout: 5000` — one update plus a nested
 *   `ctx.call(pricing.listPriceLists)` when a price list is assigned.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Name/description/price-list caps match create. Slug is not accepted
 *   and stays the previous value when the name changes.
 * - Clearing `priceListId` (omit or null) returns the group to inherit.
 * - Missing or foreign-company groups are not-found (no existence leak).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  groupDescriptionSchema,
  groupNameSchema,
  groupViewSchema,
} from "./group-view.contract.js";

export const updateGroupInputSchema = z.strictObject({
  id: z.uuid(),
  name: groupNameSchema,
  description: groupDescriptionSchema,
  priceListId: z.uuid().nullable().optional(),
});

export const updateGroupOutputSchema = groupViewSchema;

export const updateGroupContract = defineActionContract({
  name: "customers.updateGroup",
  description:
    "Update the name, description, and price-list assignment of a customer group in the staff member's active company. The slug stays the previous value. Omitting or nulling the price list returns the group to inherit the company default. Missing groups and groups that belong to another company fail with the same not-found. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateGroupInputSchema,
  output: updateGroupOutputSchema,
  permissions: ["customers:edit"],
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
