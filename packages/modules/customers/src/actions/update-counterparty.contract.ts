/**
 * Staff write contract for SHO-192 (feature SHO-191): replace a company
 * counterparty's legal name, requisites, and CRM link. Card-named
 * metadata: staff principal, client transport, `customers:edit` (same
 * as create; not `customers:delete`), write risk, exposed to AI, no
 * confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `customers.updateCustomer` (full
 * replace of the mutable fields) and `customers.createCounterparty`:
 * - `timeout: 5000` — one update plus a same-module customer load when
 *   `customerId` is set. No `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Same fields as create plus `id`. Omitted/null optional fields clear.
 *   Null `customerId` unlinks (standalone). Archived customers may stay
 *   linked. Missing or foreign-company counterparties are not-found.
 * - Output is the shared `CounterpartyView`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  counterpartyBankMfoSchema,
  counterpartyBankNameSchema,
  counterpartyCustomerIdSchema,
  counterpartyEdrpouSchema,
  counterpartyEmailSchema,
  counterpartyIbanSchema,
  counterpartyLegalAddressSchema,
  counterpartyNameSchema,
  counterpartyNotesSchema,
  counterpartyPhoneSchema,
  counterpartyViewSchema,
} from "./counterparty-view.contract.js";

export const updateCounterpartyInputSchema = z.strictObject({
  id: z.uuid(),
  name: counterpartyNameSchema,
  edrpou: counterpartyEdrpouSchema,
  legalAddress: counterpartyLegalAddressSchema,
  iban: counterpartyIbanSchema,
  bankName: counterpartyBankNameSchema,
  bankMfo: counterpartyBankMfoSchema,
  phone: counterpartyPhoneSchema,
  email: counterpartyEmailSchema,
  notes: counterpartyNotesSchema,
  customerId: counterpartyCustomerIdSchema,
});

export const updateCounterpartyOutputSchema = counterpartyViewSchema;

export const updateCounterpartyContract = defineActionContract({
  name: "customers.updateCounterparty",
  description:
    "Update a company counterparty in the staff member's active company. Replaces the legal name, requisites, and CRM customer link. Omitting or nulling optional fields clears them. Null customer id unlinks the counterparty (standalone). The linked customer may be active or archived. Missing counterparties and counterparties that belong to another company fail with the same not-found. Duplicate non-null EDRPOU in the company is a conflict. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
  principal: "staff",
  transport: "client",
  input: updateCounterpartyInputSchema,
  output: updateCounterpartyOutputSchema,
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
  timeout: 5_000,
});
