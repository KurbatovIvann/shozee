/**
 * Company-create onboarding copy shared by mobile and web (SHO-482).
 *
 * Intersection of byte-identical uk+en strings. Web uses different
 * field names (`companyTitle`, `createSubmit`); the app maps those.
 * Do not fold the web legal step into this tree — that copy lives in
 * `legal.ts` plus typed app leftovers (`legalSkip`, `stepLabel`, …).
 */
import { selectCopy, type Locale } from "../locale.js";

export type SharedCompaniesOnboardingErrorCopy = {
  readonly nameRequired: string;
  readonly nameTooLong: string;
  readonly slugInvalid: string;
  readonly slugOccupied: string;
  readonly network: string;
  readonly unavailable: string;
};

export type SharedCompaniesOnboardingCopy = {
  readonly title: string;
  readonly subtitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly slugLabel: string;
  readonly slugPlaceholder: string;
  readonly submit: string;
  readonly submitLoading: string;
  readonly errors: SharedCompaniesOnboardingErrorCopy;
};

const en: SharedCompaniesOnboardingCopy = {
  title: "About your business",
  subtitle: "Basic information to create your business profile on Shozee.",
  nameLabel: "Business name",
  namePlaceholder: "Business name",
  slugLabel: "Public address",
  slugPlaceholder: "your-business",
  submit: "Create business profile",
  submitLoading: "Creating…",
  errors: {
    nameRequired: "Enter a business name",
    nameTooLong: "Name is too long",
    slugInvalid:
      "Latin letters, digits, and hyphen only. At least 3 characters.",
    slugOccupied: "This address is already taken. Choose another.",
    network: "Network error. Check your connection.",
    unavailable: "Something went wrong. Try again.",
  },
};

const uk: SharedCompaniesOnboardingCopy = {
  title: "Про ваш бізнес",
  subtitle: "Основна інформація для створення профілю бізнесу на Шозі.",
  nameLabel: "Назва бізнесу",
  namePlaceholder: "Назва бізнесу",
  slugLabel: "Публічна адреса",
  slugPlaceholder: "vash-biznes",
  submit: "Створити профіль бізнесу",
  submitLoading: "Створюємо…",
  errors: {
    nameRequired: "Вкажіть назву бізнесу",
    nameTooLong: "Назва занадто довга",
    slugInvalid: "Тільки латиниця, цифри та дефіс. Мінімум 3 символи.",
    slugOccupied: "Ця адреса вже зайнята. Оберіть іншу.",
    network: "Помилка мережі. Перевірте з’єднання.",
    unavailable: "Щось пішло не так. Спробуйте ще раз.",
  },
};

export function sharedCompaniesOnboardingCopy(
  locale: Locale,
): SharedCompaniesOnboardingCopy {
  return selectCopy(locale, { uk, en });
}
