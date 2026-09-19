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
    "Update a company counterparty in the staff member's active company. Changes only the fields it names: an omitted field keeps its stored value and an explicit null clears it. Null customer id unlinks the counterparty (standalone). The linked customer may be active or archived. Missing counterparties and counterparties that belong to another company fail with the same not-found. Duplicate non-null EDRPOU in the company is a conflict. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second write.",
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
