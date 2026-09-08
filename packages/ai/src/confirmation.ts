import { z } from "zod";

import { staffAssistantLocale, type StaffAssistantLocale } from "./locale.js";

export const STAFF_ASSISTANT_CONFIRMATION_STATUS =
  "confirmation_required" as const;

export const staffAssistantConfirmationOutputSchema = z.object({
  status: z.literal(STAFF_ASSISTANT_CONFIRMATION_STATUS),
  challengeId: z.uuid(),
  summary: z.string().min(1),
  expiresAt: z.string().min(1),
  actionName: z.string().min(1),
  toolCallId: z.string().min(1),
});

export type StaffAssistantConfirmationOutput = z.infer<
  typeof staffAssistantConfirmationOutputSchema
>;

export function isStaffAssistantConfirmationOutput(
  value: unknown,
): value is StaffAssistantConfirmationOutput {
  return staffAssistantConfirmationOutputSchema.safeParse(value).success;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the streamed `data-confirmation` envelope or a flattened
 * confirmation object that a client echoes back in `messages[].parts`.
 */
export function confirmationFromChatPart(
  part: unknown,
): StaffAssistantConfirmationOutput | undefined {
  if (isStaffAssistantConfirmationOutput(part)) {
    return part;
  }
  if (!isRecord(part)) {
    return undefined;
  }
  return isStaffAssistantConfirmationOutput(part.data) ? part.data : undefined;
}

export const STAFF_ASSISTANT_CONFIRMATION_COPY: Record<
  StaffAssistantLocale,
  string
> = {
  en: "Confirmation required.",
  uk: "Потрібне підтвердження.",
};

/** English alias of `STAFF_ASSISTANT_CONFIRMATION_COPY.en`. */
export const STAFF_ASSISTANT_CONFIRMATION_FALLBACK_TEXT =
  STAFF_ASSISTANT_CONFIRMATION_COPY.en;

/**
 * Protocol speech when confirmation resume fails closed (expired challenge,
 * hash/binding mismatch). Ask again — do not surface a fresh challenge.
 */
export const STAFF_ASSISTANT_CONFIRMATION_EXPIRED_COPY: Record<
  StaffAssistantLocale,
  string
> = {
  en: "Confirmation expired. Ask again.",
  uk: "Підтвердження прострочене. Запитай ще раз.",
};

/**
 * Protocol speech after a modelless confirmation resume (SHO-516).
 * Past-tense statements — no second model call, no Ви-imperatives.
 */
export const STAFF_ASSISTANT_CONFIRMATION_DONE_COPY = {
  "customers.deleteCustomer": {
    uk: "Клієнта видалено.",
    en: "Customer deleted.",
  },
  "customers.deleteGroup": {
    uk: "Групу видалено.",
    en: "Group deleted.",
  },
  "customers.deleteCounterparty": {
    uk: "Контрагента видалено.",
    en: "Counterparty deleted.",
  },
  "pricing.deletePriceList": {
    uk: "Прайс-лист видалено.",
    en: "Price list deleted.",
  },
  "documents.requestSign": {
    uk: "Запит на підпис підтверджено.",
    en: "Signature request confirmed.",
  },
} as const;

export const STAFF_ASSISTANT_CONFIRMATION_DONE_FALLBACK: Record<
  StaffAssistantLocale,
  string
> = {
  uk: "Підтверджено.",
  en: "Confirmed.",
};

export function presentConfirmationDoneSpeech(options: {
  readonly locale: string | undefined;
  readonly actionName: string;
}): string {
  const locale = staffAssistantLocale(options.locale);
  switch (options.actionName) {
    case "customers.deleteCustomer":
    case "customers.deleteGroup":
    case "customers.deleteCounterparty":
    case "pricing.deletePriceList":
    case "documents.requestSign":
      return STAFF_ASSISTANT_CONFIRMATION_DONE_COPY[options.actionName][locale];
    default:
      return STAFF_ASSISTANT_CONFIRMATION_DONE_FALLBACK[locale];
  }
}
