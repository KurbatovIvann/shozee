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

export const LEGAL_IDENTITY_REQUIRED_MESSAGE =
  "Name companyType and legalName on the first save of the legal requisites.";

export const updateLegalInputSchema = z.strictObject({
  companyType: companyLegalTypeSchema.optional(),
  legalName: companyLegalNameSchema.optional(),
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
    "Upsert seller legal requisites for the staff member's active company (ФОП/ТОВ, legal name, ЄДРПОУ, address, IBAN/bank, document phone and email). Changes only the fields it names: once requisites exist, an omitted field keeps its stored value — including companyType and legalName — and an explicit null or empty string clears an optional one; on the first save an omitted optional field is stored as null and omitting companyType or legalName is a validation error. companyType and legalName reject null: they are cleared by nothing. Does not change the company's trade name, slug, or numbering prefix. Company id is never input. Re-submitting the identical payload with the same idempotency key returns the same view without a second legal row.",
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
