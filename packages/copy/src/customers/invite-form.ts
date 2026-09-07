/** Invitation create copy (uk/en). Wholesale mobile tree (SHO-476). */
import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "../chrome.js";

export type CustomersInviteFormCopy = Omit<
  FormChromeCopy,
  "submitEdit" | "submitEditLoading"
> & {
  readonly whoTitle: string;
  readonly whoHelper: string;
  readonly kindPersonal: string;
  readonly kindReusable: string;
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
  readonly accessTitle: string;
  readonly maxUsesLabel: string;
  readonly maxUsesPlaceholder: string;
  readonly maxUsesHelper: string;
  readonly expiresLabel: string;
  readonly expiresSheetTitle: string;
  readonly createdTitle: string;
  readonly createdHelper: string;
  readonly tokenLabel: string;
  readonly urlLabel: string;
  readonly copyUrl: string;
  readonly copyToken: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly done: string;
  readonly permissionCreateTitle: string;
  readonly permissionCreateDescription: string;
  readonly loadingLabel: string;
  readonly errors: {
    readonly nameTooLong: string;
    readonly phoneTooLong: string;
    readonly emailTooLong: string;
    readonly expiresInvalid: string;
    readonly expiresRange: string;
    readonly maxUsesInvalid: string;
  } & WriteErrorsCopy;
};

export const en: CustomersInviteFormCopy = {
  whoTitle: "Who",
  whoHelper:
    "This invite is for customers, not the team. After they accept, a CRM client appears with the group and price list. It does not create a counterparty.",
  kindPersonal: "Personal",
  kindReusable: "Reusable",
  nameLabel: "Name (optional)",
  namePlaceholder: "Client name",
  phoneLabel: "Phone (optional)",
  phonePlaceholder: "+380 67 000 00 00",
  emailLabel: "Email (optional)",
  emailPlaceholder: "client@email.com",
  termsTitle: "CRM terms",
  groupLabel: "Group after accept",
  groupPlaceholder: "No group",
  groupSheetTitle: "Customer group",
  groupEmptyOption: "No group",
  groupEmpty: "No groups found.",
  groupSearchPlaceholder: "Search groups…",
  assignmentUnavailable: "Assigned",
  priceListLabel: "Price list after accept",
  priceListInheritGroup: "Inherited from the group",
  priceListDefault: "Retail by default",
  priceListSheetTitle: "Price list",
  priceListEmptyOption: "Default",
  priceListEmpty: "No price lists found.",
  priceListSearchPlaceholder: "Search price lists…",
  accessTitle: "Access terms",
  maxUsesLabel: "Use limit",
  maxUsesPlaceholder: "Unlimited",
  maxUsesHelper: "Leave empty for unlimited uses.",
  expiresLabel: "Expires",
  expiresSheetTitle: "Expires",
  createdTitle: "Link",
  createdHelper:
    "Copy it now. After you leave this screen the secret cannot be shown again.",
  tokenLabel: "Token",
  urlLabel: "Link",
  copyUrl: "Copy link",
  copyToken: "Copy token",
  copied: "Copied",
  copyFailed: "Could not copy. Try again.",
  done: "Done",
  ...formChromeEn,
  permissionCreateTitle: "No permission to invite",
  permissionCreateDescription:
    "You can view invitations, but creating them needs a higher role.",
  loadingLabel: "Loading invitation",
  errors: {
    nameTooLong: "Name is too long.",
    phoneTooLong: "Phone is too long.",
    emailTooLong: "Email is too long.",
    expiresInvalid: "Enter a valid expiry date.",
    expiresRange: "Expiry must be between 1 hour and 365 days from now.",
    maxUsesInvalid: "Use limit must be a whole number of 1 or more.",
    ...writeErrorsEn,
  },
};

export const uk: CustomersInviteFormCopy = {
  whoTitle: "Кому",
  whoHelper:
    "Це запрошення для клієнтів, не для команди. Після прийняття з’явиться клієнт у CRM з групою та прайсом. Контрагента не створює.",
  kindPersonal: "Особисте",
  kindReusable: "Багаторазове",
  nameLabel: "Ім’я (необов’язково)",
  namePlaceholder: "Ім’я клієнта",
  phoneLabel: "Телефон (необов’язково)",
  phonePlaceholder: "+380 67 000 00 00",
  emailLabel: "Email (необов’язково)",
  emailPlaceholder: "client@email.com",
  termsTitle: "Умови в CRM",
  groupLabel: "Група після прийняття",
  groupPlaceholder: "Без групи",
  groupSheetTitle: "Група клієнтів",
  groupEmptyOption: "Без групи",
  groupEmpty: "Груп не знайдено.",
  groupSearchPlaceholder: "Пошук груп…",
  assignmentUnavailable: "Призначено",
  priceListLabel: "Прайс-лист після прийняття",
  priceListInheritGroup: "Успадкований від групи",
  priceListDefault: "Роздрібний за замовчуванням",
  priceListSheetTitle: "Прайс-лист",
  priceListEmptyOption: "За замовчуванням",
  priceListEmpty: "Прайс-листів не знайдено.",
  priceListSearchPlaceholder: "Пошук прайс-листів…",
  accessTitle: "Умови доступу",
  maxUsesLabel: "Ліміт використань",
  maxUsesPlaceholder: "Без ліміту",
  maxUsesHelper: "Порожнє поле — без ліміту використань.",
  expiresLabel: "Діє до",
  expiresSheetTitle: "Діє до",
  createdTitle: "Посилання",
  createdHelper:
    "Скопіюйте зараз. Після виходу з екрана секрет більше не буде доступний.",
  tokenLabel: "Токен",
  urlLabel: "Посилання",
  copyUrl: "Копіювати посилання",
  copyToken: "Копіювати токен",
  copied: "Скопійовано",
  copyFailed: "Не вдалося скопіювати. Спробуйте ще раз.",
  done: "Готово",
  ...formChromeUk,
  permissionCreateTitle: "Немає права запрошувати",
  permissionCreateDescription:
    "Ви можете переглядати запрошення, але створення потребує вищої ролі.",
  loadingLabel: "Завантаження запрошення",
  errors: {
    nameTooLong: "Ім’я задовге.",
    phoneTooLong: "Телефон задовгий.",
    emailTooLong: "Email задовгий.",
    expiresInvalid: "Вкажіть коректну дату закінчення.",
    expiresRange: "Дата має бути від 1 години до 365 днів від зараз.",
    maxUsesInvalid: "Ліміт має бути цілим числом від 1.",
    ...writeErrorsUk,
  },
};
