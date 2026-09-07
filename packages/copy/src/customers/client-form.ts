/** Client create/edit copy (uk/en). Wholesale mobile tree (SHO-476). */
import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "../chrome.js";

export type CustomersFormCopy = FormChromeCopy & {
  readonly contactsTitle: string;
  readonly contactsHelper: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly phoneLabel: string;
  readonly phonePlaceholder: string;
  readonly emailLabel: string;
  readonly emailPlaceholder: string;
  readonly termsTitle: string;
  readonly groupLabel: string;
  readonly groupPlaceholder: string;
  readonly groupSheetTitle: string;
  readonly groupEmptyOption: string;
  readonly groupEmpty: string;
  readonly groupSearchPlaceholder: string;
  readonly assignmentUnavailable: string;
  readonly priceListLabel: string;
  readonly priceListInheritGroup: string;
  readonly priceListDefault: string;
  readonly priceListSheetTitle: string;
  readonly priceListEmptyOption: string;
  readonly priceListEmpty: string;
  readonly priceListSearchPlaceholder: string;
  readonly counterpartiesTitle: string;
  readonly counterpartiesHelper: string;
  readonly counterpartiesCreateHint: string;
  readonly counterpartiesEmpty: string;
  readonly counterpartiesAdd: string;
  readonly counterpartiesEdrpouEmpty: string;
  readonly notesTitle: string;
  readonly notesLabel: string;
  readonly notesPlaceholder: string;
  readonly archiveTitle: string;
  readonly archiveActiveHelper: string;
  readonly archiveArchivedHelper: string;
  readonly archiveAction: string;
  readonly restoreAction: string;
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
    readonly phoneTooLong: string;
    readonly emailTooLong: string;
    readonly notesTooLong: string;
    readonly contactRequired: string;
  } & WriteErrorsCopy;
};

export const en: CustomersFormCopy = {
  contactsTitle: "Contacts",
  contactsHelper:
    "At least one contact is required: phone, email, or a linked Shozee account.",
  nameLabel: "Name",
  namePlaceholder: "For example, Maria Tkachenko",
  phoneLabel: "Phone",
  phonePlaceholder: "+380 67 000 00 00",
  emailLabel: "Email",
  emailPlaceholder: "client@email.com",
  termsTitle: "Service terms",
  groupLabel: "Client group",
  groupPlaceholder: "No group",
  groupSheetTitle: "Client group",
  groupEmptyOption: "No group",
  groupEmpty: "No groups found.",
  groupSearchPlaceholder: "Search groups…",
  assignmentUnavailable: "Assigned",
  priceListLabel: "Price list",
  priceListInheritGroup: "Inherited from the group",
  priceListDefault: "Retail by default",
  priceListSheetTitle: "Price list",
  priceListEmptyOption: "Default",
  priceListEmpty: "No price lists found.",
  priceListSearchPlaceholder: "Search price lists…",
  counterpartiesTitle: "Legal entities",
  counterpartiesHelper:
    "For invoices and QES. One client can have several FOPs. Groups and price lists stay on the client.",
  counterpartiesCreateHint: "Save the client to add an FOP or LLC.",
  counterpartiesEmpty: "No linked counterparties.",
  counterpartiesAdd: "Add counterparty",
  counterpartiesEdrpouEmpty: "No code",
  notesTitle: "Notes",
  notesLabel: "Internal use",
  notesPlaceholder: "Preferences, allergies, delivery details",
  archiveTitle: "Archive",
  archiveActiveHelper: "Archive first, then delete. Orders stay.",
  archiveArchivedHelper:
    "This client is archived. Delete is only available here.",
  archiveAction: "Archive",
  restoreAction: "Restore",
  deleteAction: "Delete forever",
  ...formChromeEn,
  permissionCreateTitle: "No permission to create",
  permissionCreateDescription:
    "You can view clients, but creating them needs a higher role.",
  permissionEditTitle: "No permission to edit",
  permissionEditDescription:
    "You can view this client, but editing needs a higher role.",
  notFoundTitle: "Client not found",
  notFoundDescription:
    "The record may have been deleted, or the link is out of date.",
  loadingLabel: "Loading client",
  errors: {
    nameRequired: "Enter the client name",
    nameTooLong: "Name is too long.",
    phoneTooLong: "Phone is too long.",
    emailTooLong: "Email is too long.",
    notesTooLong: "Notes are too long.",
    contactRequired: "Phone, email, or a linked account is required",
    ...writeErrorsEn,
  },
};

export const uk: CustomersFormCopy = {
  contactsTitle: "Контакти",
  contactsHelper:
    "Потрібен хоча б один контакт: телефон, email або прив’язаний акаунт Шозі.",
  nameLabel: "Ім’я",
  namePlaceholder: "Наприклад, Марія Ткаченко",
  phoneLabel: "Телефон",
  phonePlaceholder: "+380 67 000 00 00",
  emailLabel: "Email",
  emailPlaceholder: "client@email.com",
  termsTitle: "Умови обслуговування",
  groupLabel: "Група клієнтів",
  groupPlaceholder: "Без групи",
  groupSheetTitle: "Група клієнтів",
  groupEmptyOption: "Без групи",
  groupEmpty: "Груп не знайдено.",
  groupSearchPlaceholder: "Пошук груп…",
  assignmentUnavailable: "Призначено",
  priceListLabel: "Прайс-лист",
  priceListInheritGroup: "Успадкований від групи",
  priceListDefault: "Роздрібний за замовчуванням",
  priceListSheetTitle: "Прайс-лист",
  priceListEmptyOption: "За замовчуванням",
  priceListEmpty: "Прайс-листів не знайдено.",
  priceListSearchPlaceholder: "Пошук прайс-листів…",
  counterpartiesTitle: "Юрособи",
  counterpartiesHelper:
    "Для рахунків і КЕП. Один клієнт може мати кілька ФОП. Групи та прайси лишаються на клієнті.",
  counterpartiesCreateHint: "Збережіть клієнта, щоб додати ФОП або ТОВ.",
  counterpartiesEmpty: "Немає прив’язаних контрагентів.",
  counterpartiesAdd: "Додати контрагента",
  counterpartiesEdrpouEmpty: "Без коду",
  notesTitle: "Нотатки",
  notesLabel: "Для внутрішнього використання",
  notesPlaceholder: "Побажання, алергії, деталі доставки",
  archiveTitle: "Архів",
  archiveActiveHelper:
    "Спочатку архів, потім видалення. Замовлення залишаться.",
  archiveArchivedHelper: "Клієнт в архіві. Видалити можна лише звідси.",
  archiveAction: "Архівувати",
  restoreAction: "Відновити",
  deleteAction: "Видалити назавжди",
  ...formChromeUk,
  permissionCreateTitle: "Немає права створювати",
  permissionCreateDescription:
    "Ви можете переглядати клієнтів, але створення потребує вищої ролі.",
  permissionEditTitle: "Немає права редагувати",
  permissionEditDescription:
    "Ви можете переглядати цього клієнта, але редагування потребує вищої ролі.",
  notFoundTitle: "Клієнта не знайдено",
  notFoundDescription: "Можливо, запис було видалено або посилання застаріло.",
  loadingLabel: "Завантаження клієнта",
  errors: {
    nameRequired: "Вкажіть ім’я клієнта",
    nameTooLong: "Ім’я задовге.",
    phoneTooLong: "Телефон задовгий.",
    emailTooLong: "Email задовгий.",
    notesTooLong: "Нотатки задовгі.",
    contactRequired: "Потрібен телефон, email або прив’язаний акаунт",
    ...writeErrorsUk,
  },
};
