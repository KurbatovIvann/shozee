/**
 * Staff group get (SHO-177 / feature SHO-169). Mechanical choices the
 * feature card left unnamed — copy `catalog.getProduct` and the shared
 * `GroupView` from create/update:
 * - Input is `{ id }` (same as update/delete). Missing and foreign-company
 *   ids fail with the same not-found (no existence leak).
 * - Output is the shared group view, including server `slug` (UI may
 *   ignore) and `memberCount` of *active* members only.
 * - `timeout: 5000` matches the golden catalog reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). The ticket's `true` is
 *   that protocol, not the mutation idempotency suite.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { groupViewSchema } from "./group-view.contract.js";

export const getGroupInputSchema = z.strictObject({
  id: z.uuid(),
});

export const getGroupOutputSchema = groupViewSchema;

export const getGroupContract = defineActionContract({
  name: "customers.getGroup",
  description:
    "Return one customer group in the staff member's active company as the shared group view (id, name, slug, description, price-list assignment, active member count, timestamps). Missing groups and groups that belong to another company fail with the same not-found. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: getGroupInputSchema,
  output: getGroupOutputSchema,
  permissions: ["customers:view"],
  aiExposure: "exposed",
  risk: "read",
  requiresConfirmation: false,
  idempotent: false,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND"],
  audit: false,
  timeout: 5_000,
});
