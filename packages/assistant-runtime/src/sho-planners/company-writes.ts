import { toProviderToolName } from "@showzy/ai";
import {
  COMPANY_LEGAL_ADDRESS_MAX,
  COMPANY_LEGAL_NAME_MAX,
  companyLegalBankMfoSchema,
  companyLegalEdrpouSchema,
  companyLegalEmailSchema,
  companyLegalIbanSchema,
  companyLegalPhoneSchema,
  companyLegalTypeSchema,
} from "@showzy/companies/contract";

import type { ShoActionPlanners } from "./kit.js";
import {
  shoClippedField,
  shoTypedField,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_UPDATE_LEGAL = "companies.updateLegal";

const LEGAL_REQUISITES: Readonly<Record<string, ShoWriteParamMapper>> = {
  company_type: shoTypedField("companyType", companyLegalTypeSchema),
  legal_name: shoClippedField("legalName", COMPANY_LEGAL_NAME_MAX),
  edrpou: shoTypedField("edrpou", companyLegalEdrpouSchema),
  address: shoClippedField("legalAddress", COMPANY_LEGAL_ADDRESS_MAX),
  iban: shoTypedField("iban", companyLegalIbanSchema),
  mfo: shoTypedField("bankMfo", companyLegalBankMfoSchema),
  phone: shoTypedField("phone", companyLegalPhoneSchema),
  email: shoTypedField("email", companyLegalEmailSchema),
};

const SHO_COMPANY_WRITES: ShoWritePlans = {
  [SHO_UPDATE_LEGAL]: {
    toolName: toProviderToolName(SHO_UPDATE_LEGAL),
    reply: "Реквізити оновлено.",
    params: LEGAL_REQUISITES,
    required: [],
    oneOf: [Object.keys(LEGAL_REQUISITES)],
  },
};

export const SHO_COMPANY_WRITE_ACTIONS: readonly string[] = Object.freeze(
  shoWriteActions(SHO_COMPANY_WRITES),
);

export const SHO_COMPANY_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze(shoWritePlannerParams(SHO_COMPANY_WRITES));

export const SHO_COMPANY_WRITE_PLANNERS: ShoActionPlanners = Object.freeze(
  shoWritePlanners(SHO_COMPANY_WRITES),
);
