/**
 * Staff-assistant request locale (SHO-518). Protocol copy and speech
 * fallbacks key off this; it is not a tenant access grant.
 */
import { z } from "zod";

export const STAFF_ASSISTANT_LOCALES = ["uk", "en"] as const;
export type StaffAssistantLocale = (typeof STAFF_ASSISTANT_LOCALES)[number];
export const STAFF_ASSISTANT_DEFAULT_LOCALE: StaffAssistantLocale = "uk";

export const staffAssistantLocaleSchema = z.enum(STAFF_ASSISTANT_LOCALES);

export function staffAssistantLocale(
  locale: string | undefined,
): StaffAssistantLocale {
  return locale === "en" ? "en" : STAFF_ASSISTANT_DEFAULT_LOCALE;
}

export function fillStaffAssistantCopy(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  let filled = template;
  for (const [key, value] of Object.entries(values)) {
    filled = filled.replaceAll(`{{${key}}}`, value);
  }
  return filled;
}
