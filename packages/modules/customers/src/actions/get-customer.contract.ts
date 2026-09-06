/**
 * Staff customer get (SHO-175 / feature SHO-169). Mechanical choices the
 * feature card left unnamed — copy `catalog.getProduct` and the shared
 * `CustomerView` from create/update:
 * - Input is `{ id }` (same as update/archive). Missing and
 *   foreign-company ids fail with the same not-found (no existence leak).
 * - Output is the shared customer view, including `status` and
 *   `linkedCounterpartyCount`. Archived rows are returned (staff may
 *   inspect before restore). No order-count field.
 * - `timeout: 5000` matches the golden catalog reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). The ticket's `true` is
 *   that protocol, not the mutation idempotency suite.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { customerViewSchema } from "./customer-view.contract.js";

export const getCustomerInputSchema = z.strictObject({
  id: z.uuid(),
});

export const getCustomerOutputSchema = customerViewSchema;

export const getCustomerContract = defineActionContract({
  name: "customers.getCustomer",
  description:
    "Return one CRM customer in the staff member's active company as the shared customer view (id, name, contacts, notes, group and price-list assignments, status, linked counterparty count, timestamps). Missing customers and customers that belong to another company fail with the same not-found. Company id is never input. Does not return order counts.",
  principal: "staff",
  transport: "client",
  input: getCustomerInputSchema,
  output: getCustomerOutputSchema,
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
