/**
 * Staff write contract for SHO-172 (feature SHO-169): create a customer
 * group in the active company. Card-named metadata: staff principal,
 * client transport, `customers:edit` (v1 group writes; not
 * `customers:create` / `customers:groups:*`), write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from the catalog write golden
 * (`catalog.createProduct`) and the feature card:
 * - `timeout: 5000` — one execution transaction plus a nested
 *   `ctx.call(pricing.listPriceLists)` when a price list is assigned.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `name` is trimmed and capped at `GROUP_NAME_MAX` (120).
 * - `description` optional, max 2000. Empty/omitted stores null.
 * - `priceListId` optional uuid; omitted/null means inherit the company
 *   default (store null, no sentinel). Resolved via `ctx.call`, never
 *   by importing `@showzy/db/schema/pricing`.
 * - Slug is generated server-side and is not accepted on input.
 * - `sort_order` defaults to 0 in the database; not on this slice's input.
 * - Output is the created group view so the client has ids without a
 *   second round-trip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  groupDescriptionSchema,
  groupNameSchema,
  groupViewSchema,
} from "./group-view.contract.js";

export { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX };

export const createGroupInputSchema = z.strictObject({
  name: groupNameSchema,
  description: groupDescriptionSchema,
  priceListId: z.uuid().nullable().optional(),
});

export const createGroupOutputSchema = groupViewSchema;

export const createGroupContract = defineActionContract({
  name: "customers.createGroup",
  description:
    "Create a customer group in the staff member's active company. Takes a trimmed name (max 120), optional description (max 2000), and an optional price-list id. Omitting or nulling the price list means inherit the company default — the row stores null, not a sentinel. The slug is generated from the name (Ukrainian transliteration; empty or colliding slugs fall back to group-{shortid}) and is not accepted on input. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created group and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createGroupInputSchema,
  output: createGroupOutputSchema,
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
