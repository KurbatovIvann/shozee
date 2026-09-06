/**
 * Status-only staff write (SHO-174 / customers-T4). Copies the catalog
 * `restoreProduct` golden: one column, no confirmation, no events.
 *
 * Mechanical choices the feature card left unnamed:
 * - `timeout: 5000` matches other staff writes with no nested `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Input is `{ id }` only. Company id is never input.
 * - Output is the shared `CustomerView` so the client does not need a
 *   second round-trip after the flip.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { customerViewSchema } from "./customer-view.contract.js";

export const restoreCustomerInputSchema = z.strictObject({
  id: z.uuid(),
});

export const restoreCustomerOutputSchema = customerViewSchema;

export const restoreCustomerContract = defineActionContract({
  name: "customers.restoreCustomer",
  description:
    "Restore an archived CRM customer in the staff member's active company by setting status to active. This is a status-only write: name, contacts, notes, group, and price-list assignment do not change. A customer that is already active is returned unchanged. Missing or foreign-company customers fail with the same not-found. Company id is never input. Hard delete is a separate action.",
  principal: "staff",
  transport: "client",
  input: restoreCustomerInputSchema,
  output: restoreCustomerOutputSchema,
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
