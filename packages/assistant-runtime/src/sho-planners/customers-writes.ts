import { toProviderToolName } from "@showzy/ai";
import type { ShoParam, ShoRecordType } from "@showzy/sho-protocol";
import {
  CUSTOMER_EMAIL_MAX,
  CUSTOMER_NAME_MAX,
  CUSTOMER_NOTES_MAX,
  CUSTOMER_PHONE_MAX,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
} from "@showzy/validation/customers";

import {
  shoIsRef,
  shoRefLocator,
  shoRefused,
  type ShoActionPlanners,
} from "./kit.js";
import {
  shoIdFrom,
  shoIdOnly,
  shoSpanText,
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteMapped,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_CUSTOMER = "customers.createCustomer";

export const SHO_UPDATE_CUSTOMER = "customers.updateCustomer";

export const SHO_ARCHIVE_CUSTOMER = "customers.archiveCustomer";

export const SHO_RESTORE_CUSTOMER = "customers.restoreCustomer";

export const SHO_DELETE_CUSTOMER = "customers.deleteCustomer";

export const SHO_SET_GROUP = "customers.setGroup";

export const SHO_CREATE_GROUP = "customers.createGroup";

export const SHO_UPDATE_GROUP = "customers.updateGroup";

export const SHO_DELETE_GROUP = "customers.deleteGroup";

export const SHO_READ_AS_UPDATE_NOTE =
  "Прочитано як редагування клієнта, не створення";

export const SHO_READ_AS_CUSTOMER_UPDATE_NOTE =
  "Прочитано як редагування клієнта, не групи";

export const SHO_READ_AS_FOCUS_CUSTOMER_NOTE =
  "Прочитано як дію над клієнтом з розмови";

export const SHO_READ_AS_FOCUS_GROUP_NOTE =
  "Прочитано як дію над групою з розмови";

const MISREAD_NOTES: Readonly<Record<string, string>> = {
  read_as_update: SHO_READ_AS_UPDATE_NOTE,
  read_as_customer_update: SHO_READ_AS_CUSTOMER_UPDATE_NOTE,
};

const FOCUS_CUSTOMER_NOTES: Readonly<Record<string, string>> = {
  read_as_focus_type: SHO_READ_AS_FOCUS_CUSTOMER_NOTE,
};

const FOCUS_GROUP_NOTES: Readonly<Record<string, string>> = {
  read_as_focus_type: SHO_READ_AS_FOCUS_GROUP_NOTE,
};

const SET_GROUP_NOTES: Readonly<Record<string, string>> = {
  ...MISREAD_NOTES,
  ...FOCUS_GROUP_NOTES,
};

const clipped = (param: ShoParam, max: number): string | null =>
  shoSpokenText(param)?.slice(0, max) ?? null;

const soleCustomerId: ShoWriteParamMapper = (param) => {
  const only = Array.isArray(param) && param.length === 1 ? param[0] : null;
  return shoIsRef(only) ? shoIdFrom(only, "id") : "unsupported_param";
};

const created =
  (type: ShoRecordType, max: number): ShoWriteParamMapper =>
  (param, command) => {
    const nominative =
      command.creates?.type === type ? (command.creates.name ?? "").trim() : "";
    const text =
      nominative.length > 0 ? nominative.slice(0, max) : clipped(param, max);
    return text === null ? "unsupported_param" : { name: text };
  };

const renamed =
  (max: number): ShoWriteParamMapper =>
  (param) => {
    const text = clipped(param, max);
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

const clippedSpan =
  (field: string, max: number): ShoWriteParamMapper =>
  (param) => {
    const text = shoSpanText(param)?.slice(0, max) ?? null;
    return text === null ? "unsupported_param" : { [field]: text };
  };

const createdName = created("customer", CUSTOMER_NAME_MAX);

const createdGroupName = created("group", GROUP_NAME_MAX);

const renamedTo = renamed(CUSTOMER_NAME_MAX);

const renamedGroupTo = renamed(GROUP_NAME_MAX);

const comment = clippedSpan("notes", CUSTOMER_NOTES_MAX);

const describedGroup = clippedSpan("description", GROUP_DESCRIPTION_MAX);

const phone = contact("phone", CUSTOMER_PHONE_MAX);

const email = contact("email", CUSTOMER_EMAIL_MAX);

const priceList = shoIdOnly("priceListId");

const onResolvedRecord = (
  action: string,
  reply: string,
  param: string,
  notes: Readonly<Record<string, string>>,
): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { [param]: shoIdOnly("id") },
  required: [param],
  notes,
});

const SHO_CUSTOMER_WRITES: ShoWritePlans = {
  [SHO_CREATE_CUSTOMER]: {
    toolName: toProviderToolName(SHO_CREATE_CUSTOMER),
    reply: "Клієнта створено.",
    params: {
      new_name: createdName,
      phone,
      email,
      comment,
      group: shoIdOnly("groupId"),
    },
    required: ["new_name"],
    oneOf: [["phone", "email"]],
    notes: MISREAD_NOTES,
  },
  [SHO_UPDATE_CUSTOMER]: {
    toolName: toProviderToolName(SHO_UPDATE_CUSTOMER),
    reply: "Клієнта оновлено.",
    params: {
      customer: shoIdOnly("id"),
      rename_to: renamedTo,
      phone,
      email,
      comment,
      group: shoIdOnly("groupId"),
    },
    required: ["customer"],
    oneOf: [["rename_to", "phone", "email", "comment", "group"]],
    notes: MISREAD_NOTES,
  },
  [SHO_ARCHIVE_CUSTOMER]: onResolvedRecord(
    SHO_ARCHIVE_CUSTOMER,
    "Клієнта заархівовано.",
    "customer",
    FOCUS_CUSTOMER_NOTES,
  ),
  [SHO_RESTORE_CUSTOMER]: onResolvedRecord(
    SHO_RESTORE_CUSTOMER,
    "Клієнта повернуто з архіву.",
    "customer",
    FOCUS_CUSTOMER_NOTES,
  ),
  [SHO_DELETE_CUSTOMER]: onResolvedRecord(
    SHO_DELETE_CUSTOMER,
    "Клієнта видалено.",
    "customer",
    FOCUS_CUSTOMER_NOTES,
  ),
  [SHO_SET_GROUP]: {
    toolName: toProviderToolName(SHO_UPDATE_CUSTOMER),
    reply: "Клієнта оновлено.",
    params: {
      customers: soleCustomerId,
      group: shoIdOnly("groupId"),
    },
    required: ["customers", "group"],
    notes: SET_GROUP_NOTES,
  },
  [SHO_CREATE_GROUP]: {
    toolName: toProviderToolName(SHO_CREATE_GROUP),
    reply: "Групу створено.",
    params: {
      new_name: createdGroupName,
      description: describedGroup,
      price_list: priceList,
    },
    required: ["new_name"],
  },
  [SHO_UPDATE_GROUP]: {
    toolName: toProviderToolName(SHO_UPDATE_GROUP),
    reply: "Групу оновлено.",
    params: {
      group: shoIdOnly("id"),
      rename_to: renamedGroupTo,
      description: describedGroup,
      price_list: priceList,
    },
    required: ["group"],
    oneOf: [["rename_to", "description", "price_list"]],
    notes: FOCUS_GROUP_NOTES,
  },
  [SHO_DELETE_GROUP]: onResolvedRecord(
    SHO_DELETE_GROUP,
    "Групу видалено.",
    "group",
    FOCUS_GROUP_NOTES,
  ),
};

export const SHO_CUSTOMER_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_CUSTOMER_WRITES);

export const SHO_CUSTOMER_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_CUSTOMER_WRITES);

export const SHO_CUSTOMER_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_CUSTOMER_WRITES);
