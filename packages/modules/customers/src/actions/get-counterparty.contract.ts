/**
 * Staff counterparty get (SHO-194 / feature SHO-191). Mechanical choices
 * the feature card left unnamed — copy `customers.getCustomer` /
 * `customers.getGroup` and the shared `CounterpartyView` from T10:
 * - Input is `{ id }` (same as update). Missing and foreign-company ids
 *   fail with the same not-found (no existence leak).
 * - Output is the shared counterparty view, including live
 *   `customerId` / `customerName` (null when standalone).
 * - `timeout: 5000` matches the golden CRM reads.
 * - No `rateLimit` override — staff default 120/min per user.
 * - `idempotent: false` like other staff reads: core.md §5 treats reads as
 *   naturally idempotent (no key, no storage). Do not invent mutation
 *   idempotency on reads.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import { counterpartyViewSchema } from "./counterparty-view.contract.js";

export const getCounterpartyInputSchema = z.strictObject({
  id: z.uuid(),
});

export const getCounterpartyOutputSchema = counterpartyViewSchema;

export const getCounterpartyContract = defineActionContract({
  name: "customers.getCounterparty",
  description:
    "Return one company counterparty (legal face for documents) in the staff member's active company as the shared counterparty view (id, legal name, requisites, optional linked CRM customer id and live customer name, timestamps). Missing counterparties and counterparties that belong to another company fail with the same not-found. Company id is never input.",
  principal: "staff",
  transport: "client",
  input: getCounterpartyInputSchema,
  output: getCounterpartyOutputSchema,
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
