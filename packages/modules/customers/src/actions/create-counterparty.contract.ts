/**
 * Staff write contract for SHO-192 (feature SHO-191): create a company
 * counterparty (legal face for documents). Card-named metadata: staff
 * principal, client transport, `customers:edit` (v1 / groups writes; not
 * `customers:create` / `customers:delete`), write risk, exposed to AI,
 * no confirmation, idempotent, audited, no events.
 *
 * Mechanical choices copied from `customers.createGroup`:
 * - `timeout: 5000` — one insert plus a same-module customer load when
 *   `customerId` is set. No `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Caps live on the shared view contract. Empty optional strings store
 *   null. Omit/null `customerId` is standalone. Duplicate non-null
 *   `(company_id, edrpou)` is ConflictError, not a silent upsert.
 * - Company id is never input. Output is the shared `CounterpartyView`.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  COUNTERPARTY_BANK_MFO_MAX,
  COUNTERPARTY_BANK_NAME_MAX,
  COUNTERPARTY_EDRPOU_MAX,
  COUNTERPARTY_EMAIL_MAX,
  COUNTERPARTY_IBAN_MAX,
  COUNTERPARTY_LEGAL_ADDRESS_MAX,
  COUNTERPARTY_NAME_MAX,
  COUNTERPARTY_NOTES_MAX,
  COUNTERPARTY_PHONE_MAX,
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

export {
  COUNTERPARTY_BANK_MFO_MAX,
  COUNTERPARTY_BANK_NAME_MAX,
  COUNTERPARTY_EDRPOU_MAX,
  COUNTERPARTY_EMAIL_MAX,
  COUNTERPARTY_IBAN_MAX,
  COUNTERPARTY_LEGAL_ADDRESS_MAX,
  COUNTERPARTY_NAME_MAX,
  COUNTERPARTY_NOTES_MAX,
  COUNTERPARTY_PHONE_MAX,
};

export const createCounterpartyInputSchema = z.strictObject({
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

export const createCounterpartyOutputSchema = counterpartyViewSchema;

export const createCounterpartyContract = defineActionContract({
  name: "customers.createCounterparty",
  description:
    "Create a company counterparty (legal face for documents) in the staff member's active company. Takes a trimmed legal name (max 300) and optional requisites: edrpou (max 10), legal address, IBAN, bank name, bank MFO, phone, email, notes, and an optional CRM customer id. Omitting or nulling the customer id creates a standalone counterparty. The linked customer may be active or archived and must belong to the same company. Empty optional strings store null. Duplicate non-null EDRPOU in the company is a conflict, not a silent upsert. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the already-created counterparty and does not insert duplicates.",
  principal: "staff",
  transport: "client",
  input: createCounterpartyInputSchema,
  output: createCounterpartyOutputSchema,
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
