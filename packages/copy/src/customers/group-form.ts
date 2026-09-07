/** Group create/edit copy (uk/en). Wholesale mobile tree (SHO-476). */
import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "../chrome.js";

export type CustomersGroupFormCopy = FormChromeCopy & {
  readonly aboutTitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly descriptionLabel: string;
  readonly descriptionPlaceholder: string;
  readonly memberHint: string;
  readonly termsTitle: string;
  readonly priceListLabel: string;
  readonly priceListPlaceholder: string;
  readonly priceListSheetTitle: string;
  readonly priceListEmptyOption: string;
  readonly priceListEmpty: string;
  readonly priceListSearchPlaceholder: string;
  readonly assignmentUnavailable: string;
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
    readonly descriptionTooLong: string;
  } & WriteErrorsCopy;
};

export const en: CustomersGroupFormCopy = {
  aboutTitle: "About the group",
  nameLabel: "Name",
  namePlaceholder: "For example, Wholesale buyers",
  descriptionLabel: "Description (optional)",
  descriptionPlaceholder: "Who this group is for",
  memberHint:
    "The group has {{members}}. Deleting the group only removes this assignment.",
  termsTitle: "Terms",
  priceListLabel: "Default price list",
  priceListPlaceholder: "Retail",
  priceListSheetTitle: "Price list",
  priceListEmptyOption: "Default",
  priceListEmpty: "No price lists found.",
  priceListSearchPlaceholder: "Search price lists…",
  assignmentUnavailable: "Assigned",
  ...formChromeEn,
  permissionCreateTitle: "No permission to create",
  permissionCreateDescription:
    "You can view groups, but creating them needs a higher role.",
  permissionEditTitle: "No permission to edit",
  permissionEditDescription:
    "You can view this group, but editing needs a higher role.",
  notFoundTitle: "Group not found",
  notFoundDescription:
    "The group may have been deleted, or the link is out of date.",
  loadingLabel: "Loading group",
  errors: {
    nameRequired: "Enter the group name",
    nameTooLong: "Name is too long.",
    descriptionTooLong: "Description is too long.",
    ...writeErrorsEn,
  },
};

export const uk: CustomersGroupFormCopy = {
  aboutTitle: "Про групу",
  nameLabel: "Назва",
  namePlaceholder: "Наприклад, Оптові покупці",
  descriptionLabel: "Опис (необовʼязково)",
  descriptionPlaceholder: "Кому підходить ця група",
  memberHint:
    "У групі {{members}}. Видалення групи лише прибере це призначення.",
  termsTitle: "Умови",
  priceListLabel: "Прайс-лист за замовчуванням",
  priceListPlaceholder: "Роздрібний",
  priceListSheetTitle: "Прайс-лист",
  priceListEmptyOption: "За замовчуванням",
  priceListEmpty: "Прайс-листів не знайдено.",
  priceListSearchPlaceholder: "Пошук прайс-листів…",
  assignmentUnavailable: "Призначено",
  ...formChromeUk,
  permissionCreateTitle: "Немає права створювати",
  permissionCreateDescription:
    "Ви можете переглядати групи, але створення потребує вищої ролі.",
  permissionEditTitle: "Немає права редагувати",
  permissionEditDescription:
    "Ви можете переглядати цю групу, але редагування потребує вищої ролі.",
  notFoundTitle: "Групу не знайдено",
  notFoundDescription: "Можливо, її було видалено або посилання застаріло.",
  loadingLabel: "Завантаження групи",
  errors: {
    nameRequired: "Вкажіть назву групи",
    nameTooLong: "Назва задовга.",
    descriptionTooLong: "Опис задовгий.",
    ...writeErrorsUk,
  },
};
