import {
  kyivCalendarDate,
  kyivNamedPeriodRange,
  toProviderToolName,
} from "@showzy/ai";
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
import {
  INVITE_EXPIRES_MAX_MS,
  INVITE_EXPIRES_MIN_MS,
  invitePhoneSchema,
} from "@showzy/invites/contract";
import type { ShoParam } from "@showzy/sho-protocol";
import { CUSTOMER_NAME_MAX } from "@showzy/validation/customers";
import type { ZodType } from "zod";

import {
  shoPlanFallback,
  shoRefLocator,
  shoRefused,
  type ShoActionPlanner,
  type ShoActionPlanners,
} from "./kit.js";
import {
  shoSpokenText,
  shoWriteActions,
  shoWritePlanner,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_INVITE = "invites.create";

export const SHO_UPDATE_LEGAL = "companies.updateLegal";

export const SHO_INVITE_EXPIRES_FIELD = "expiresAt";

export function shoTypedText(param: ShoParam): string | null {
  if (Array.isArray(param) || !("value" in param)) {
    return null;
  }
  const value = param.value;
  if (typeof value !== "string") {
    return null;
  }
  const typed = value.trim();
  return typed.length === 0 ? null : typed;
}

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

const idOnly =
  (field: string): ShoWriteParamMapper =>
  (param) => {
    const locator = shoRefLocator(param);
    if (shoRefused(locator)) {
      return locator;
    }
    return locator.by === "id" ? { [field]: locator.id } : "unsupported_param";
  };

const isReusable: ShoWriteParamMapper = (param) => {
  const value = shoTypedText(param);
  return value === "true" || value === "false"
    ? { isReusable: value === "true" }
    : "unsupported_param";
};

const expiryToken: ShoWriteParamMapper = (param) => {
  const token = shoTypedText(param);
  return token === null
    ? "unsupported_param"
    : { [SHO_INVITE_EXPIRES_FIELD]: token };
};

const EXPIRES_IN_DAYS = /^days:(\d{1,4})$/;

const EXPIRES_ON_DATE = /^date:(\d{2})-(\d{2})$/;

const dayStamp = (year: number, month: number, day: number): string =>
  new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

function expiryDay(token: string, now: Date): string | null {
  const today = kyivCalendarDate(now);
  const year = Number(today.slice(0, 4));
  const inDays = EXPIRES_IN_DAYS.exec(token);
  if (inDays !== null) {
    return dayStamp(
      year,
      Number(today.slice(5, 7)),
      Number(today.slice(8, 10)) + Number(inDays[1]),
    );
  }
  const onDate = EXPIRES_ON_DATE.exec(token);
  if (onDate === null) {
    return null;
  }
  const monthDay = `${onDate[1] ?? ""}-${onDate[2] ?? ""}`;
  const onYear = monthDay >= today.slice(5) ? year : year + 1;
  const stamp = dayStamp(onYear, Number(onDate[1]), Number(onDate[2]));
  return stamp.slice(5) === monthDay ? stamp : null;
}

export function shoInviteExpiresAt(token: string, now: Date): string | null {
  const day = expiryDay(token, now);
  const range =
    day === null ? null : kyivNamedPeriodRange(`range:${day}..${day}`, now);
  if (range === null) {
    return null;
  }
  const ahead = Date.parse(range.createdTo) - now.getTime();
  return ahead >= INVITE_EXPIRES_MIN_MS && ahead <= INVITE_EXPIRES_MAX_MS
    ? range.createdTo
    : null;
}

const resolvingExpiry = (plan: ShoWritePlan): ShoActionPlanner => {
  const planner = shoWritePlanner(plan);
  return {
    writes: planner.writes,
    plan: (command, now) => {
      const planned = planner.plan(command, now);
      if (planned.kind !== "call") {
        return planned;
      }
      const token = planned.input[SHO_INVITE_EXPIRES_FIELD];
      const expiresAt =
        typeof token === "string" ? shoInviteExpiresAt(token, now) : null;
      return expiresAt === null
        ? shoPlanFallback("unsupported_param")
        : {
            ...planned,
            input: { ...planned.input, [SHO_INVITE_EXPIRES_FIELD]: expiresAt },
          };
    },
  };
};

const SHO_CREATE_INVITE_PLAN: ShoWritePlan = {
  toolName: toProviderToolName(SHO_CREATE_INVITE),
  reply: "Запрошення створено.",
  params: {
    is_reusable: isReusable,
    expires: expiryToken,
    group: idOnly("groupId"),
    price_list: idOnly("priceListId"),
    new_name: clipped("name", CUSTOMER_NAME_MAX),
    phone: typed("phone", invitePhoneSchema),
  },
  required: ["is_reusable", "expires"],
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

export const SHO_COMPANY_WRITE_ACTIONS: readonly string[] = Object.freeze([
  SHO_CREATE_INVITE,
  ...shoWriteActions(SHO_COMPANY_WRITES),
]);

export const SHO_COMPANY_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  [SHO_CREATE_INVITE]: Object.freeze(
    Object.keys(SHO_CREATE_INVITE_PLAN.params),
  ),
  ...shoWritePlannerParams(SHO_COMPANY_WRITES),
});

export const SHO_COMPANY_WRITE_PLANNERS: ShoActionPlanners = Object.freeze({
  [SHO_CREATE_INVITE]: resolvingExpiry(SHO_CREATE_INVITE_PLAN),
  ...shoWritePlanners(SHO_COMPANY_WRITES),
});
