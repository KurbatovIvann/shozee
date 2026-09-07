/** Company settings hub + legal editor copy namespace (uk/en). Shared strings live in `@showzy/copy/companies`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import {
  sharedCompaniesLegalCopy,
  sharedCompaniesSettingsCopy,
  type SharedCompaniesLegalCopy,
  type SharedCompaniesSettingsCopy,
} from "@showzy/copy/companies";

import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "./copy";

export type CompaniesLegalFormCopy = SharedCompaniesLegalCopy &
  Omit<
    FormChromeCopy,
    "closeSheet" | "submitCreate" | "submitCreateLoading"
  > & {
    readonly edrpouPlaceholder: string;
    readonly bankEdrpouLabel: string;
    readonly bankEdrpouPlaceholder: string;
    readonly contactsTitle: string;
    readonly contactsHelper: string;
    readonly phoneLabel: string;
    readonly phonePlaceholder: string;
    readonly emailLabel: string;
    readonly emailPlaceholder: string;
    readonly submitAdd: string;
    readonly submitAddLoading: string;
    readonly loadingLabel: string;
    readonly errors: SharedCompaniesLegalCopy["errors"] &
      WriteErrorsCopy & {
        readonly legalNameTooLong: string;
        readonly edrpouTooLong: string;
        readonly legalAddressTooLong: string;
        readonly ibanTooLong: string;
        readonly bankNameTooLong: string;
        readonly bankMfoTooLong: string;
        readonly bankEdrpouTooLong: string;
        readonly phoneTooLong: string;
        readonly emailTooLong: string;
        readonly conflict: string;
      };
  };

export type CompaniesCopy = SharedCompaniesSettingsCopy & {
  readonly legalForm: CompaniesLegalFormCopy;
};

type MobileLegalFormExtension = {
  readonly edrpouPlaceholder: string;
  readonly bankEdrpouLabel: string;
  readonly bankEdrpouPlaceholder: string;
  readonly contactsTitle: string;
  readonly contactsHelper: string;
  readonly phoneLabel: string;
  readonly phonePlaceholder: string;
  readonly emailLabel: string;
  readonly emailPlaceholder: string;
  readonly submitAdd: string;
  readonly submitAddLoading: string;
  readonly loadingLabel: string;
  readonly errors: {
    readonly legalNameTooLong: string;
    readonly edrpouTooLong: string;
    readonly legalAddressTooLong: string;
    readonly ibanTooLong: string;
    readonly bankNameTooLong: string;
    readonly bankMfoTooLong: string;
    readonly bankEdrpouTooLong: string;
    readonly phoneTooLong: string;
    readonly emailTooLong: string;
    readonly conflict: string;
  };
};

const extraLegalEn: MobileLegalFormExtension = {
  edrpouPlaceholder: "1234567890",
  bankEdrpouLabel: "Bank EDRPOU (optional)",
  bankEdrpouPlaceholder: "12345678",
  contactsTitle: "Contacts for documents",
  contactsHelper: "May differ from profile contacts",
  phoneLabel: "Phone",
  phonePlaceholder: "+380 44 000 00 00",
  emailLabel: "Email (optional)",
  emailPlaceholder: "documents@company.ua",
  submitAdd: "Add requisites",
  submitAddLoading: "Saving…",
  loadingLabel: "Loading legal requisites",
  errors: {
    legalNameTooLong: "Name is too long.",
    edrpouTooLong: "EDRPOU is too long.",
    legalAddressTooLong: "Legal address is too long.",
    ibanTooLong: "IBAN is too long.",
    bankNameTooLong: "Bank name is too long.",
    bankMfoTooLong: "MFO is too long.",
    bankEdrpouTooLong: "Bank EDRPOU is too long.",
    phoneTooLong: "Phone is too long.",
    emailTooLong: "Email is too long.",
    conflict: "Could not save. Try again.",
  },
};

const extraLegalUk: MobileLegalFormExtension = {
  edrpouPlaceholder: "1234567890",
  bankEdrpouLabel: "ЄДРПОУ банку (необовʼязково)",
  bankEdrpouPlaceholder: "12345678",
  contactsTitle: "Контакти для документів",
  contactsHelper: "Можуть відрізнятися від контактів профілю",
  phoneLabel: "Телефон",
  phonePlaceholder: "+380 44 000 00 00",
  emailLabel: "Email (необовʼязково)",
  emailPlaceholder: "documents@company.ua",
  submitAdd: "Додати реквізити",
  submitAddLoading: "Збереження…",
  loadingLabel: "Завантаження реквізитів",
  errors: {
    legalNameTooLong: "Назва задовга.",
    edrpouTooLong: "ЄДРПОУ задовге.",
    legalAddressTooLong: "Юридична адреса задовга.",
    ibanTooLong: "IBAN задовгий.",
    bankNameTooLong: "Назва банку задовга.",
    bankMfoTooLong: "МФО задовге.",
    bankEdrpouTooLong: "ЄДРПОУ банку задовге.",
    phoneTooLong: "Телефон задовгий.",
    emailTooLong: "Email задовгий.",
    conflict: "Не вдалося зберегти. Спробуйте ще раз.",
  },
};

export function companiesCopy(locale: Locale): CompaniesCopy {
  const settings = sharedCompaniesSettingsCopy(locale);
  const legal = sharedCompaniesLegalCopy(locale);
  const extraLegal = selectCopy(locale, {
    uk: extraLegalUk,
    en: extraLegalEn,
  });
  const formChrome = locale === "uk" ? formChromeUk : formChromeEn;
  const writeErrors = locale === "uk" ? writeErrorsUk : writeErrorsEn;
  return {
    ...settings,
    legalForm: {
      ...legal,
      ...formChrome,
      ...extraLegal,
      errors: {
        ...legal.errors,
        ...extraLegal.errors,
        ...writeErrors,
      },
    },
  };
}
