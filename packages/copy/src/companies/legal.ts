/**
 * Legal-form copy shared by mobile company settings and web onboarding
 * (SHO-482).
 *
 * Byte-identical uk+en intersection only. Divergent placeholders
 * (`edrpouPlaceholder`), wording (`legalNameTooLong`), and one-app
 * keys (`contactsHelper`, `submitAdd`, `legalSkip`) stay in the apps.
 * Web maps `companyTitle` → `companySection` and `bankTitle` →
 * `bankSection`.
 */
import { selectCopy, type Locale } from "../locale.js";

export type SharedCompaniesLegalErrorCopy = {
  readonly legalNameRequired: string;
};

export type SharedCompaniesLegalCopy = {
  readonly typeLabel: string;
  readonly typeFop: string;
  readonly typeTov: string;
  readonly companyTitle: string;
  readonly legalNameLabel: string;
  readonly legalNamePlaceholder: string;
  readonly edrpouLabel: string;
  readonly legalAddressLabel: string;
  readonly legalAddressPlaceholder: string;
  readonly bankTitle: string;
  readonly ibanLabel: string;
  readonly ibanPlaceholder: string;
  readonly bankNameLabel: string;
  readonly bankNamePlaceholder: string;
  readonly bankMfoLabel: string;
  readonly bankMfoPlaceholder: string;
  readonly errors: SharedCompaniesLegalErrorCopy;
};

const en: SharedCompaniesLegalCopy = {
  typeLabel: "Entity type",
  typeFop: "FOP",
  typeTov: "LLC",
  companyTitle: "Company information",
  legalNameLabel: "Legal name",
  legalNamePlaceholder: "FOP Last First Patronymic",
  edrpouLabel: "EDRPOU / TIN",
  legalAddressLabel: "Legal address",
  legalAddressPlaceholder: "Kyiv, Khreshchatyk St, 1",
  bankTitle: "Bank details",
  ibanLabel: "IBAN",
  ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
  bankNameLabel: "Bank",
  bankNamePlaceholder: "Monobank",
  bankMfoLabel: "MFO",
  bankMfoPlaceholder: "322001",
  errors: {
    legalNameRequired: "Enter the legal name",
  },
};

const uk: SharedCompaniesLegalCopy = {
  typeLabel: "Тип суб’єкта",
  typeFop: "ФОП",
  typeTov: "ТОВ",
  companyTitle: "Інформація про компанію",
  legalNameLabel: "Юридична назва",
  legalNamePlaceholder: "ФОП Прізвище Ім’я По батькові",
  edrpouLabel: "ЄДРПОУ / ІПН",
  legalAddressLabel: "Юридична адреса",
  legalAddressPlaceholder: "м. Київ, вул. Хрещатик, 1",
  bankTitle: "Банківські реквізити",
  ibanLabel: "IBAN",
  ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
  bankNameLabel: "Банк",
  bankNamePlaceholder: "Монобанк",
  bankMfoLabel: "МФО",
  bankMfoPlaceholder: "322001",
  errors: {
    legalNameRequired: "Вкажіть юридичну назву",
  },
};

export function sharedCompaniesLegalCopy(
  locale: Locale,
): SharedCompaniesLegalCopy {
  return selectCopy(locale, { uk, en });
}
