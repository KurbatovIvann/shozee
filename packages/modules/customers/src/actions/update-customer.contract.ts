/**
 * Staff write contract for SHO-173 (feature SHO-169): replace a CRM
 * customer's name, contacts, notes, and assignments. Card-named metadata:
 * staff principal, client transport, `customers:edit`, write risk, exposed
 * to AI, no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `catalog.updateProduct` (full-replace of
 * the mutable fields) and `customers.createCustomer`:
 * - `timeout: 10000` — nested `pricing.listPriceLists` shares remaining
 *   budget when a price list is assigned.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Same fields as create plus `id`. Omitted/null optional fields clear
 *   (inherit for group/price list). Contact refine holds on the submitted
 *   payload so the last of phone/email/userId cannot be cleared.
 * - Missing or foreign-company customers are not-found. Archived rows
 *   may be updated; status is not input and is not restored.
 * - Output is the shared `CustomerView`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  CONTACT_REQUIRED_MESSAGE,
  customerAssignmentIdSchema,
  customerEmailSchema,
  customerNameSchema,
  customerNotesSchema,
  customerPhoneSchema,
  customerUserIdSchema,
  customerViewSchema,
  hasCustomerContact,
} from "./customer-view.contract.js";

export const updateCustomerInputSchema = z
  .strictObject({
    id: z.uuid(),
    name: customerNameSchema,
    phone: customerPhoneSchema,
    email: customerEmailSchema,
    userId: customerUserIdSchema,
    notes: customerNotesSchema,
    groupId: customerAssignmentIdSchema,
    priceListId: customerAssignmentIdSchema,
  })
  .refine(hasCustomerContact, { message: CONTACT_REQUIRED_MESSAGE });

export const updateCustomerOutputSchema = customerViewSchema;

export const updateCustomerContract = defineActionContract({
  name: "customers.updateCustomer",
  description:
    "Update a CRM customer in the staff member's active company. Replaces name, contacts, notes, and group/price-list assignments. At least one of phone, email, or userId must remain. Empty group or price-list assignment means inherit. Missing customers and customers that belong to another company fail with the same not-found. Archived customers may be edited; status is not changed. Company id and status are never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateCustomerInputSchema,
  output: updateCustomerOutputSchema,
  permissions: ["customers:edit"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION", "NOT_FOUND", "CONFLICT"],
  audit: true,
  timeout: 10_000,
});
