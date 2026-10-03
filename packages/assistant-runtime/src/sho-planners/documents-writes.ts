import { toProviderToolName } from "@showzy/ai";
import type { ShoParam } from "@showzy/sho-protocol";

import {
  shoIsRef,
  shoRefLocator,
  shoRefused,
  type ShoActionPlanners,
} from "./kit.js";
import { SHOZEE_DOCUMENT_TYPES } from "./reads.js";
import {
  shoIdOnly,
  shoSpanText,
  shoSpokenText,
  shoWriteActions,
  shoWritePlanners,
  shoWritePlannerParams,
  type ShoWriteParamMapper,
  type ShoWritePlan,
  type ShoWritePlans,
} from "./write-kit.js";

export const SHO_CREATE_DOCUMENT = "documents.createFromOrder";

export const SHO_CANCEL_DOCUMENT = "documents.cancel";

export const SHO_SHARE_DOCUMENT = "documents.share";

export const SHO_REQUEST_SIGN_DOCUMENT = "documents.requestSign";

const focusHeldId =
  (field: string): ShoWriteParamMapper =>
  (param) => {
    if (!shoIsRef(param) || param.status !== "context") {
      return "unsupported_param";
    }
    const locator = shoRefLocator(param);
    if (shoRefused(locator)) {
      return locator;
    }
    return locator.by === "id"
      ? { [field]: locator.id }
      : "unresolved_reference";
  };

const spokenDocumentNumber = (param: ShoParam): string | null =>
  Array.isArray(param) || "status" in param ? null : shoSpanText(param);

const documentReference: ShoWriteParamMapper = (param) => {
  if (!shoIsRef(param)) {
    const spoken = spokenDocumentNumber(param);
    return spoken === null ? "unsupported_param" : { documentNumber: spoken };
  }
  if (param.status !== "context") {
    return "unsupported_param";
  }
  const locator = shoRefLocator(param);
  if (shoRefused(locator)) {
    return locator;
  }
  return locator.by === "id"
    ? { documentId: locator.id }
    : "unresolved_reference";
};

const documentType: ShoWriteParamMapper = (param) => {
  const value = shoSpokenText(param);
  return value !== null && SHOZEE_DOCUMENT_TYPES.includes(value)
    ? { type: value }
    : "unsupported_param";
};

const onDocument = (action: string, reply: string): ShoWritePlan => ({
  toolName: toProviderToolName(action),
  reply,
  params: { document_ref: documentReference },
  required: ["document_ref"],
});

const SHO_DOCUMENT_WRITES: ShoWritePlans = {
  [SHO_CREATE_DOCUMENT]: {
    toolName: toProviderToolName(SHO_CREATE_DOCUMENT),
    reply: "Документ створено.",
    params: {
      order_number: focusHeldId("orderId"),
      document_type: documentType,
      counterparty: shoIdOnly("counterpartyId"),
    },
    required: ["order_number", "document_type"],
  },
  [SHO_CANCEL_DOCUMENT]: onDocument(SHO_CANCEL_DOCUMENT, "Документ скасовано."),
  [SHO_SHARE_DOCUMENT]: onDocument(
    SHO_SHARE_DOCUMENT,
    "Посилання на документ готове.",
  ),
  [SHO_REQUEST_SIGN_DOCUMENT]: onDocument(
    SHO_REQUEST_SIGN_DOCUMENT,
    "Запит на підпис надіслано.",
  ),
};

export const SHO_DOCUMENT_WRITE_ACTIONS: readonly string[] =
  shoWriteActions(SHO_DOCUMENT_WRITES);

export const SHO_DOCUMENT_WRITE_PLANNER_PARAMS: Readonly<
  Record<string, readonly string[]>
> = shoWritePlannerParams(SHO_DOCUMENT_WRITES);

export const SHO_DOCUMENT_WRITE_PLANNERS: ShoActionPlanners =
  shoWritePlanners(SHO_DOCUMENT_WRITES);
