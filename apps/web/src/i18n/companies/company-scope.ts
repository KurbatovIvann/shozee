/** Company-scope copy namespace (uk/en). Shared strings live in `@showzy/copy/companies`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import {
  sharedCompaniesScopeCopy,
  type SharedCompaniesScopeCopy,
} from "@showzy/copy/companies";

export type CompanyScopeCopy = SharedCompaniesScopeCopy & {
  readonly pickerTitle: string;
  readonly pickerHint: string;
  readonly unknownTitle: string;
  readonly unknownDescription: string;
  readonly backToPicker: string;
  readonly switcher: string;
  readonly errorDescription: string;
  readonly retry: string;
};

type WebCompanyScopeExtension = {
  readonly pickerTitle: string;
  readonly pickerHint: string;
  readonly unknownTitle: string;
  readonly unknownDescription: string;
  readonly backToPicker: string;
  readonly switcher: string;
  readonly errorDescription: string;
  readonly retry: string;
};

const extraEn: WebCompanyScopeExtension = {
  pickerTitle: "Choose a company",
  pickerHint: "Pick the company you want to work in.",
  unknownTitle: "Company not found",
  unknownDescription: "This address does not match any company you belong to.",
  backToPicker: "Back to companies",
  switcher: "Company",
  errorDescription: "Check your connection and try again.",
  retry: "Try again",
};

const extraUk: WebCompanyScopeExtension = {
  pickerTitle: "Оберіть компанію",
  pickerHint: "Оберіть компанію, з якою хочете працювати.",
  unknownTitle: "Компанію не знайдено",
  unknownDescription: "Ця адреса не збігається з вашими компаніями.",
  backToPicker: "До списку компаній",
  switcher: "Компанія",
  errorDescription: "Перевірте з’єднання та спробуйте ще раз.",
  retry: "Спробувати ще раз",
};

export function companyScopeCopy(locale: Locale): CompanyScopeCopy {
  const shared = sharedCompaniesScopeCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return { ...shared, ...extra };
}
