/** Company-resolution copy namespace (uk/en). Shared strings live in `@showzy/copy/companies`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import {
  sharedCompaniesScopeCopy,
  type SharedCompaniesScopeCopy,
} from "@showzy/copy/companies";

export type CompanyResolutionCopy = SharedCompaniesScopeCopy & {
  readonly errorDescription: string;
  readonly retry: string;
  readonly multipleTitle: string;
  readonly multipleDescription: string;
  readonly signOut: string;
};

type MobileCompanyResolutionExtension = {
  readonly errorDescription: string;
  readonly retry: string;
  readonly multipleTitle: string;
  readonly multipleDescription: string;
  readonly signOut: string;
};

const extraEn: MobileCompanyResolutionExtension = {
  errorDescription:
    "Check your connection and try again. Company onboarding has not started.",
  retry: "Try Again",
  multipleTitle: "Choose a company",
  multipleDescription:
    "This account belongs to multiple companies. Company switching is coming soon.",
  signOut: "Sign Out",
};

const extraUk: MobileCompanyResolutionExtension = {
  errorDescription:
    "Перевірте з’єднання та спробуйте ще раз. Створення компанії не розпочато.",
  retry: "Спробувати ще раз",
  multipleTitle: "Оберіть компанію",
  multipleDescription:
    "Цей акаунт належить до кількох компаній. Перемикання між компаніями з’явиться незабаром.",
  signOut: "Вийти",
};

export function companyResolutionCopy(locale: Locale): CompanyResolutionCopy {
  const shared = sharedCompaniesScopeCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return { ...shared, ...extra };
}
