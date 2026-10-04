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
import type { ZodType } from "zod";

import type { ShoActionPlanners } from "./kit.js";
import {
  shoSpokenText,
  shoTypedText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_UPDATE_LEGAL = "companies.updateLegal";

const typed =
  (field: string, schema: ZodType): ShoWriteParamMapper =>
  (param) => {
    const value = shoTypedText(param);
    return value !== null && schema.safeParse(value).success
      ? { [field]: value }
      : "unsupported_param";
  };

const clipped =
  (field: string, max: number): ShoWriteParamMapper =>
  (param) => {
    const text = shoSpokenText(param)?.slice(0, max) ?? null;
    return text === null ? "unsupported_param" : { [field]: text };
  };

const SHO_COMPANY_WRITES: ShoWritePlans = {
  [SHO_UPDATE_LEGAL]: {
    toolName: toProviderToolName(SHO_UPDATE_LEGAL),
    reply: "Реквізити оновлено.",
    params: {
      company_type: typed("companyType", companyLegalTypeSchema),
      legal_name: clipped("legalName", COMPANY_LEGAL_NAME_MAX),
      edrpou: typed("edrpou", companyLegalEdrpouSchema),
      address: clipped("legalAddress", COMPANY_LEGAL_ADDRESS_MAX),
      iban: typed("iban", companyLegalIbanSchema),
      mfo: typed("bankMfo", companyLegalBankMfoSchema),
      phone: typed("phone", companyLegalPhoneSchema),
      email: typed("email", companyLegalEmailSchema),
    },
    required: ["company_type", "legal_name"],
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
