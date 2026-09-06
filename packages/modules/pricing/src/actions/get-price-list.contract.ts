/**
 * Staff price-list get (SHO-184 / pricing-T4). Mechanical choices the
 * feature card left unnamed — copy `catalog.getProduct`, do not invent
 * a second get-one shape:
 * - Input is `{ id }` (uuid). Company id is never input.
 * - Missing and foreign-company ids fail with the same not-found (no
 *   existence leak).
 * - `entryCount` is the row count of `price_list_entries` for that list.
 *   Assignment counts are out of scope.
 * - `timeout: 5000` matches the golden catalog/pricing reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md treats reads as
 *   naturally idempotent (no key, no storage).
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { PRICE_LIST_NAME_MAX } from "./list-price-lists.contract.js";

export const getPriceListInputSchema = z.object({
  id: z.uuid(),
});

export const getPriceListOutputSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(PRICE_LIST_NAME_MAX),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  entryCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const getPriceListContract = defineActionContract({
  name: "pricing.getPriceList",
  description:
    "Return one price list in the staff member's active company, including id, name, isDefault, isActive, the number of price-list entry rows, and timestamps. Missing lists and lists that belong to another company fail with the same not-found. Company id is never input. Does not return assignment counts.",
  principal: "staff",
  transport: "client",
  input: getPriceListInputSchema,
  output: getPriceListOutputSchema,
  permissions: ["pricing:view"],
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
