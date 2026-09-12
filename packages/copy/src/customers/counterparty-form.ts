/** Counterparty create/edit copy (uk/en). Wholesale mobile tree (SHO-476). */
import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "../chrome.js";

export type CustomersCounterpartyFormCopy = FormChromeCopy & {
  readonly customerTitle: string;
  readonly customerHelper: string;
  readonly customerLabel: string;
  readonly customerPlaceholder: string;
  readonly customerSheetTitle: string;
  readonly customerEmptyOption: string;
  readonly customerEmpty: string;
  readonly customerSearchPlaceholder: string;
  readonly pickerLoadingMoreLabel: string;
  readonly pickerLoadMoreLabel: string;
  readonly openClient: string;
  readonly assignmentUnavailable: string;
  readonly requisitesTitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly edrpouLabel: string;
  readonly edrpouPlaceholder: string;
  readonly legalAddressLabel: string;
  readonly legalAddressPlaceholder: string;
  readonly bankTitle: string;
  readonly ibanLabel: string;
  readonly ibanPlaceholder: string;
  readonly bankNameLabel: string;
  readonly bankNamePlaceholder: string;
  readonly bankMfoLabel: string;
  readonly bankMfoPlaceholder: string;
  readonly contactsTitle: string;
  readonly phoneLabel: string;
  readonly phonePlaceholder: string;
  readonly emailLabel: string;
  readonly emailPlaceholder: string;
  readonly notesLabel: string;
  readonly notesPlaceholder: string;
  readonly deleteTitle: string;
  readonly deleteHelper: string;
  readonly deleteAction: string;
  readonly permissionCreateTitle: string;
  readonly permissionCreateDescription: string;
  readonly permissionEditTitle: string;
  readonly permissionEditDescription: string;
  readonly notFoundTitle: string;
  readonly notFoundDescription: string;
  readonly loadingLabel: string;
  readonly errors: {
    readonly nameRequired: string;
    readonly nameTooLong: string;
    readonly edrpouTooLong: string;
    readonly legalAddressTooLong: string;
    readonly ibanTooLong: string;
    readonly bankNameTooLong: string;
    readonly bankMfoTooLong: string;
    readonly phoneTooLong: string;
    readonly emailTooLong: string;
    readonly notesTooLong: string;
    readonly conflict: string;
  } & WriteErrorsCopy;
};

export const en: CustomersCounterpartyFormCopy = {
  customerTitle: "Client",
  customerHelper:
    "Optional. Without a client the counterparty stays for documents only — for example a supplier.",
  customerLabel: "CRM client",
  customerPlaceholder: "No client",
  customerSheetTitle: "Client",
  customerEmptyOption: "No client",
  customerEmpty: "No clients found.",
  customerSearchPlaceholder: "Search clients…",
  pickerLoadingMoreLabel: "Loading more",
  pickerLoadMoreLabel: "Load more",
  openClient: "Open client",
  assignmentUnavailable: "Assigned",
  requisitesTitle: "Requisites",
  nameLabel: "Counterparty name",
  namePlaceholder: "FOP or LLC",
  edrpouLabel: "EDRPOU",
  edrpouPlaceholder: "12345678",
  legalAddressLabel: "Legal address",
  legalAddressPlaceholder: "City, street, building",
  bankTitle: "Bank details",
  ibanLabel: "IBAN",
  ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
  bankNameLabel: "Bank name",
  bankNamePlaceholder: "JSC CB PrivatBank",
  bankMfoLabel: "MFO",
  bankMfoPlaceholder: "322313",
  contactsTitle: "Contacts",
  phoneLabel: "Phone",
  phonePlaceholder: "+380 44 000 00 00",
  emailLabel: "Email",
  emailPlaceholder: "office@company.ua",
  notesLabel: "Notes",
  notesPlaceholder: "Payment terms, document workflow",
  deleteTitle: "Delete",
  deleteHelper:
    "The counterparty will be deleted forever. A linked client stays. This cannot be undone.",
  deleteAction: "Delete counterparty",
  ...formChromeEn,
  permissionCreateTitle: "No permission to create",
  permissionCreateDescription:
    "You can view counterparties, but creating them needs a higher role.",
  permissionEditTitle: "No permission to edit",
  permissionEditDescription:
    "You can view this counterparty, but editing needs a higher role.",
  notFoundTitle: "Counterparty not found",
  notFoundDescription:
    "The record may have been deleted, or the link is out of date.",
  loadingLabel: "Loading counterparty",
  errors: {
    nameRequired: "Enter the counterparty name",
    nameTooLong: "Name is too long.",
    edrpouTooLong: "EDRPOU is too long.",
    legalAddressTooLong: "Legal address is too long.",
    ibanTooLong: "IBAN is too long.",
    bankNameTooLong: "Bank name is too long.",
    bankMfoTooLong: "MFO is too long.",
    phoneTooLong: "Phone is too long.",
    emailTooLong: "Email is too long.",
    notesTooLong: "Notes are too long.",
    conflict: "A counterparty with this EDRPOU already exists.",
    ...writeErrorsEn,
  },
};

export const uk: CustomersCounterpartyFormCopy = {
  customerTitle: "Клієнт",
  customerHelper:
    "Необов’язково. Без клієнта контрагент лишається лише для документів — наприклад, постачальник.",
  customerLabel: "CRM-клієнт",
  customerPlaceholder: "Без клієнта",
  customerSheetTitle: "Клієнт",
  customerEmptyOption: "Без клієнта",
  customerEmpty: "Клієнтів не знайдено.",
  customerSearchPlaceholder: "Пошук клієнтів…",
  pickerLoadingMoreLabel: "Завантаження",
  pickerLoadMoreLabel: "Завантажити ще",
  openClient: "Відкрити клієнта",
  assignmentUnavailable: "Призначено",
  requisitesTitle: "Реквізити",
  nameLabel: "Назва контрагента",
  namePlaceholder: "ФОП або ТОВ",
  edrpouLabel: "ЄДРПОУ",
  edrpouPlaceholder: "12345678",
  legalAddressLabel: "Юридична адреса",
  legalAddressPlaceholder: "Місто, вулиця, будинок",
  bankTitle: "Банківські дані",
  ibanLabel: "IBAN",
  ibanPlaceholder: "UA00 0000 0000 0000 0000 0000 000",
  bankNameLabel: "Назва банку",
  bankNamePlaceholder: "АТ КБ «ПриватБанк»",
  bankMfoLabel: "МФО",
  bankMfoPlaceholder: "322313",
  contactsTitle: "Контакти",
  phoneLabel: "Телефон",
  phonePlaceholder: "+380 44 000 00 00",
  emailLabel: "Email",
  emailPlaceholder: "office@company.ua",
  notesLabel: "Примітки",
  notesPlaceholder: "Умови оплати, особливості документообігу",
  deleteTitle: "Видалення",
  deleteHelper:
    "Контрагента буде видалено назавжди. Клієнт (якщо був прив’язаний) залишиться. Цю дію не можна скасувати.",
  deleteAction: "Видалити контрагента",
  ...formChromeUk,
  permissionCreateTitle: "Немає права створювати",
  permissionCreateDescription:
    "Ви можете переглядати контрагентів, але створення потребує вищої ролі.",
  permissionEditTitle: "Немає права редагувати",
  permissionEditDescription:
    "Ви можете переглядати цього контрагента, але редагування потребує вищої ролі.",
  notFoundTitle: "Контрагента не знайдено",
  notFoundDescription: "Можливо, запис було видалено або посилання застаріло.",
  loadingLabel: "Завантаження контрагента",
  errors: {
    nameRequired: "Вкажіть назву контрагента",
    nameTooLong: "Назва задовга.",
    edrpouTooLong: "ЄДРПОУ задовге.",
    legalAddressTooLong: "Юридична адреса задовга.",
    ibanTooLong: "IBAN задовгий.",
    bankNameTooLong: "Назва банку задовга.",
    bankMfoTooLong: "МФО задовге.",
    phoneTooLong: "Телефон задовгий.",
    emailTooLong: "Email задовгий.",
    notesTooLong: "Примітки задовгі.",
    conflict: "Контрагент з таким ЄДРПОУ уже існує.",
    ...writeErrorsUk,
  },
};
