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
import {
  ENTITY_REF_EXACTLY_ONE_MESSAGE,
  entityRefQuerySchema,
  hasExactlyOneReference,
} from "@showzy/validation/entity-ref";
import { z } from "zod";

import { customerViewSchema } from "./customer-view.contract.js";

export const getCustomerInputSchema = z
  .strictObject({
    id: z.uuid().optional(),
    query: entityRefQuerySchema.optional(),
  })
  .refine(hasExactlyOneReference, { message: ENTITY_REF_EXACTLY_ONE_MESSAGE });

export type GetCustomerInput = z.output<typeof getCustomerInputSchema>;

export const getCustomerOutputSchema = customerViewSchema;

export const getCustomerContract = defineActionContract({
  name: "customers.getCustomer",
  description:
    "Return one CRM customer in the staff member's active company as the shared customer view (id, name, contacts, notes, group and price-list assignments, status, linked counterparty count, timestamps). Takes exactly one of a canonical id or a human query (name, phone, or email); the query matches active and archived customers alike. A unique exact match (or a unique name in another Ukrainian case) returns that customer. Several exact matches fail with a conflict carrying the matching customers as options. No match fails with not-found carrying the nearest customers, which is empty when nothing is near. Missing customers and customers that belong to another company fail with the same not-found. Company id is never input. Does not return order counts.",
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
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: false,
  timeout: 5_000,
});
