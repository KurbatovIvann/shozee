import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  customerAssignmentIdSchema,
  customerEmailSchema,
  customerNameSchema,
  customerNotesSchema,
  customerPhoneSchema,
  customerUserIdSchema,
  customerViewSchema,
} from "./customer-view.contract.js";

export const updateCustomerInputSchema = z.strictObject({
  id: z.uuid(),
  name: customerNameSchema,
  phone: customerPhoneSchema,
  email: customerEmailSchema,
  userId: customerUserIdSchema,
  notes: customerNotesSchema,
  groupId: customerAssignmentIdSchema,
  priceListId: customerAssignmentIdSchema,
});

export const updateCustomerOutputSchema = customerViewSchema;

export const updateCustomerContract = defineActionContract({
  name: "customers.updateCustomer",
  description:
    "Update a CRM customer in the staff member's active company. Changes only the fields it names: an omitted field keeps its stored value and an explicit null clears it. At least one of phone, email, or userId must remain on the stored customer. A null group or price-list assignment means inherit. Missing customers and customers that belong to another company fail with the same not-found. Archived customers may be edited; status is not changed. Company id and status are never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
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
