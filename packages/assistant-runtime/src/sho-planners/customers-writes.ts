import { toProviderToolName } from "@showzy/ai";
import type { ShoParam } from "@showzy/sho-protocol";
import {
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
  CUSTOMER_PHONE_MAX,
} from "@showzy/validation/customers";

import { shoRefLocator, shoRefused, type ShoActionPlanners } from "./kit.js";
import {
  shoSpanText,
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_CUSTOMER = "customers.createCustomer";

export const SHO_UPDATE_CUSTOMER = "customers.updateCustomer";

export const SHO_READ_AS_UPDATE_NOTE =
  "Прочитано як редагування клієнта, не створення";

export const SHO_READ_AS_CUSTOMER_UPDATE_NOTE =
  "Прочитано як редагування клієнта, не групи";

const MISREAD_NOTES: Readonly<Record<string, string>> = {
  read_as_update: SHO_READ_AS_UPDATE_NOTE,
  read_as_customer_update: SHO_READ_AS_CUSTOMER_UPDATE_NOTE,
};

const clipped = (param: ShoParam, max: number): string | null =>
  shoSpokenText(param)?.slice(0, max) ?? null;

const idOnly =
  (field: string): ShoWriteParamMapper =>
  (param) => {
    const locator = shoRefLocator(param);
    if (shoRefused(locator)) {
      return locator;
    }
    return locator.by === "id" ? { [field]: locator.id } : "unsupported_param";
  };

const createdName: ShoWriteParamMapper = (param, command) => {
  const nominative =
    command.creates?.type === "customer"
      ? (command.creates.name ?? "").trim()
      : "";
  const text =
    nominative.length > 0
      ? nominative.slice(0, CUSTOMER_NAME_MAX)
      : clipped(param, CUSTOMER_NAME_MAX);
  return text === null ? "unsupported_param" : { name: text };
};

const renamedTo: ShoWriteParamMapper = (param) => {
  const text = clipped(param, CUSTOMER_NAME_MAX);
  return text === null ? "unsupported_param" : { name: text };
};

const contact =
  (field: string, max: number): ShoWriteParamMapper =>
  (param) => {
    const text = shoSpokenText(param);
    return text === null || text.length > max
      ? "unsupported_param"
      : { [field]: text };
  };

const comment: ShoWriteParamMapper = (param) => {
  const text = shoSpanText(param)?.slice(0, CUSTOMER_NOTES_MAX) ?? null;
  return text === null ? "unsupported_param" : { notes: text };
};

const phone = contact("phone", CUSTOMER_PHONE_MAX);

const email = contact("email", CUSTOMER_EMAIL_MAX);

const SHO_CUSTOMER_WRITES: ShoWritePlans = {
  [SHO_CREATE_CUSTOMER]: {
    toolName: toProviderToolName(SHO_CREATE_CUSTOMER),
    reply: "Клієнта створено.",
    params: {
      new_name: createdName,
      phone,
      email,
      comment,
      group: idOnly("groupId"),
    },
    required: ["new_name"],
    oneOf: [["phone", "email"]],
    notes: MISREAD_NOTES,
  },
  [SHO_UPDATE_CUSTOMER]: {
    toolName: toProviderToolName(SHO_UPDATE_CUSTOMER),
    reply: "Клієнта оновлено.",
    params: {
      customer: idOnly("id"),
      rename_to: renamedTo,
      phone,
      email,
      comment,
      group: idOnly("groupId"),
    },
    required: ["customer"],
    notes: MISREAD_NOTES,
  },
};

export const SHO_CUSTOMER_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_CUSTOMER_WRITES);

export const SHO_CUSTOMER_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_CUSTOMER_WRITES);

export const SHO_CUSTOMER_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_CUSTOMER_WRITES);
