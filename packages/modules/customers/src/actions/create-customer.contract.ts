/**
 * Staff write contract for SHO-173 (feature SHO-169): create a CRM
 * customer in the active company. Card-named metadata: staff principal,
 * client transport, `customers:create`, write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from the catalog write golden — do not invent
 * a second shape:
 * - `timeout: 10000` — nested `pricing.listPriceLists` (`timeout: 5000`)
 *   shares the remaining budget when a price list is assigned; same
 *   caller-side raise as `catalog.setProductImages` / `orders.create`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Name / phone / email / notes caps live on the shared view contract.
 * - Empty `groupId` / `priceListId` = inherit (store NULL). Company id
 *   is never input. Create always sets `status: active`.
 * - Output is the shared `CustomerView` so the client has the id without
 *   a second round-trip.
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

export const createCustomerInputSchema = z
  .strictObject({
    name: customerNameSchema,
    phone: customerPhoneSchema,
    email: customerEmailSchema,
    userId: customerUserIdSchema,
    notes: customerNotesSchema,
    groupId: customerAssignmentIdSchema,
    priceListId: customerAssignmentIdSchema,
  })
  .refine(hasCustomerContact, { message: CONTACT_REQUIRED_MESSAGE });

export const createCustomerOutputSchema = customerViewSchema;

export const createCustomerContract = defineActionContract({
  name: "customers.createCustomer",
  description:
    "Create a CRM customer in the staff member's active company. Takes a trimmed name, at least one of phone, email, or userId (better-auth text id, wire-only), optional notes, and optional group and price-list assignments. Empty group or price-list assignment means inherit (group list, then company default, then catalog base). Missing or foreign group or price list fail with the same not-found. Company id and status are never input; the row is created active. Re-submitting the identical payload with the same idempotency key returns the already-created customer and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createCustomerInputSchema,
  output: createCustomerOutputSchema,
  permissions: ["customers:create"],
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
