/**
 * Staff write contract for SHO-224 (feature SHO-222): upsert this
 * company's seller legal requisites. Card-named metadata: staff
 * principal, client transport, `settings:payments`, write risk, exposed
 * to AI, no confirmation, idempotent, audited, no events (documents
 * must not live-refresh issued docs).
 *
 * Mechanical choices copied from `customers.updateCounterparty`:
 * - `timeout: 5000` — one upsert of the companies-owned legal row. No
 *   `ctx.call`.
 * - No `rateLimit` override — staff default 120/min per user.
 * - Caps live on the shared view contract. Empty optional strings store
 *   null. Does not change `companies.name` / `slug` / `prefix`.
 * - Company id is never input. Output is the shared company view.
 */
import { defineActionContract } from "@showzy/core/contract";
import { z } from "zod";

import {
  COMPANY_LEGAL_ADDRESS_MAX,
  COMPANY_LEGAL_BANK_EDRPOU_MAX,
  COMPANY_LEGAL_BANK_MFO_MAX,
  COMPANY_LEGAL_BANK_NAME_MAX,
  COMPANY_LEGAL_EDRPOU_MAX,
  COMPANY_LEGAL_EMAIL_MAX,
  COMPANY_LEGAL_IBAN_MAX,
  COMPANY_LEGAL_NAME_MAX,
  COMPANY_LEGAL_PHONE_MAX,
  companyLegalAddressSchema,
  companyLegalBankEdrpouSchema,
  companyLegalBankMfoSchema,
  companyLegalBankNameSchema,
  companyLegalEdrpouSchema,
  companyLegalEmailSchema,
  companyLegalIbanSchema,
  companyLegalNameSchema,
  companyLegalPhoneSchema,
  companyLegalTypeSchema,
  companyViewSchema,
} from "./company-view.contract.js";

export {
  COMPANY_LEGAL_ADDRESS_MAX,
  COMPANY_LEGAL_BANK_EDRPOU_MAX,
  COMPANY_LEGAL_BANK_MFO_MAX,
  COMPANY_LEGAL_BANK_NAME_MAX,
  COMPANY_LEGAL_EDRPOU_MAX,
  COMPANY_LEGAL_EMAIL_MAX,
  COMPANY_LEGAL_IBAN_MAX,
  COMPANY_LEGAL_NAME_MAX,
  COMPANY_LEGAL_PHONE_MAX,
};

export const updateLegalInputSchema = z.strictObject({
  companyType: companyLegalTypeSchema,
  legalName: companyLegalNameSchema,
  edrpou: companyLegalEdrpouSchema,
  legalAddress: companyLegalAddressSchema,
  iban: companyLegalIbanSchema,
  bankName: companyLegalBankNameSchema,
  bankMfo: companyLegalBankMfoSchema,
  bankEdrpou: companyLegalBankEdrpouSchema,
  phone: companyLegalPhoneSchema,
  email: companyLegalEmailSchema,
});

export const updateLegalOutputSchema = companyViewSchema;

export const updateLegalContract = defineActionContract({
  name: "companies.updateLegal",
  description:
    "Upsert seller legal requisites for the staff member's active company (ФОП/ТОВ, legal name, ЄДРПОУ, address, IBAN/bank, document phone and email). Empty optional strings store null. Does not change the company's trade name, slug, or numbering prefix. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second legal row.",
  principal: "staff",
  transport: "client",
  input: updateLegalInputSchema,
  output: updateLegalOutputSchema,
  permissions: ["settings:payments"],
  aiExposure: "exposed",
  risk: "write",
  requiresConfirmation: false,
  idempotent: true,
  emits: [],
  atomicCalls: [],
  atomicCallers: [],
  errors: ["VALIDATION"],
  audit: true,
  timeout: 5_000,
});
