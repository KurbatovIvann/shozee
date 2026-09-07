/**
 * Staff pricing copy (SHO-478).
 *
 * Wholesale move of the mobile price-lists tree. Web has no pricing
 * copy today — do not invent web strings here. Chrome spreads come
 * from `./chrome`. Do not import catalog, contract, or pricing types.
 */
import {
  formChromeEn,
  formChromeUk,
  writeErrorsEn,
  writeErrorsUk,
  type FormChromeCopy,
  type WriteErrorsCopy,
} from "./chrome.js";
import { selectCopy, type Locale } from "./locale.js";
import type { CountForms } from "./plural.js";

export type PricingCountForms = CountForms & {
  readonly none: string;
};

export type PricingMutationCopy = {
  readonly error: string;
  readonly offline: string;
  readonly permission: string;
};

export type PricingEmptyCopy = {
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly searchTitle: string;
  readonly searchDescription: string;
  readonly reset: string;
  readonly catalogTitle: string;
  readonly catalogDescription: string;
  readonly create: string;
};

export type PricingFormErrorsCopy = {
  readonly nameRequired: string;
  readonly nameTooLong: string;
  readonly priceInvalid: string;
} & WriteErrorsCopy;

export type PricingFormCopy = Omit<FormChromeCopy, "closeSheet"> & {
  readonly createTitle: string;
  readonly editTitle: string;
  readonly aboutTitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly statusTitle: string;
  readonly defaultLabel: string;
  readonly defaultDescription: string;
  readonly activeLabel: string;
  readonly inactiveLabel: string;
  readonly activeDescriptionOn: string;
  readonly activeDescriptionOff: string;
  readonly defaultAlwaysActive: string;
  readonly pricesTitle: string;
  readonly createPricesHint: string;
  readonly emptyPriceHint: string;
  readonly productSearchLabel: string;
  readonly productSearchPlaceholder: string;
  readonly bulkLabel: string;
  readonly bulkPlaceholder: string;
  readonly bulkApply: string;
  readonly bulkInvalid: string;
  readonly bulkApplied: string;
  readonly catalogBaseLabel: string;
  readonly archivedBadge: string;
  readonly expandVariants: string;
  readonly collapseVariants: string;
  readonly variantInheritHint: string;
  readonly noProducts: string;
  readonly pricesLoading: string;
  readonly cannotDeactivateDefault: string;
  readonly permissionCreateTitle: string;
  readonly permissionCreateDescription: string;
  readonly permissionEditTitle: string;
  readonly permissionEditDescription: string;
  readonly notFoundTitle: string;
  readonly notFoundDescription: string;
  readonly loadingLabel: string;
  readonly errors: PricingFormErrorsCopy;
};

export type SharedPricingCopy = {
  readonly title: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly createLabel: string;
  readonly backLabel: string;
  readonly editLabel: string;
  readonly optionsLabel: string;
  readonly defaultBadge: string;
  readonly inactiveBadge: string;
  readonly loadingLabel: string;
  readonly loadingMoreLabel: string;
  readonly hint: string;
  readonly filters: {
    readonly all: string;
    readonly active: string;
    readonly inactive: string;
  };
  readonly prices: PricingCountForms;
  readonly empty: PricingEmptyCopy;
  readonly options: {
    readonly setDefault: string;
    readonly clearDefault: string;
    readonly activate: string;
    readonly deactivate: string;
    readonly delete: string;
    readonly close: string;
  };
  readonly confirm: {
    readonly deleteTitle: string;
    readonly deleteDescription: string;
    readonly deleteConfirm: string;
    readonly cancel: string;
  };
  readonly toast: {
    readonly cannotDeactivateDefault: string;
  };
  readonly mutation: PricingMutationCopy;
  readonly form: PricingFormCopy;
};

const enForm: PricingFormCopy = {
  createTitle: "New price list",
  editTitle: "Edit price list",
  aboutTitle: "About the list",
  nameLabel: "Name",
  namePlaceholder: "For example, Wholesale",
  statusTitle: "Status",
  defaultLabel: "Default price list",
  defaultDescription: "Used by customers without their own assignment",
  activeLabel: "Active",
  inactiveLabel: "Inactive",
  activeDescriptionOn: "Included when prices are resolved",
  activeDescriptionOff: "Skipped when prices are resolved",
  defaultAlwaysActive: "The default list is always active",
  pricesTitle: "Product prices",
  createPricesHint:
    "After creating the list you can set per-product prices. An empty field uses the catalog base price.",
  emptyPriceHint: "An empty price inherits from the catalog",
  productSearchLabel: "Search products",
  productSearchPlaceholder: "Search products…",
  bulkLabel: "Bulk discount",
  bulkPlaceholder: "Discount %",
  bulkApply: "Apply",
  bulkInvalid: "Enter a discount from 1 to 100%",
  bulkApplied: "{{percent}}% discount applied to all products",
  catalogBaseLabel: "Base price {{price}}",
  archivedBadge: "Archived",
  expandVariants: "Show variants",
  collapseVariants: "Hide variants",
  variantInheritHint:
    "Empty inherits this list’s product price, then the chain",
  noProducts: "No products found.",
  pricesLoading: "Loading products",
  ...formChromeEn,
  changedLabel: "changed",
  cannotDeactivateDefault: "Turn off “default” first",
  submitCreateLoading: "Creating…",
  permissionCreateTitle: "No permission to create",
  permissionCreateDescription:
    "You can view price lists but cannot create them.",
  permissionEditTitle: "No permission to edit",
  permissionEditDescription: "You can view price lists but cannot change them.",
  notFoundTitle: "Price list not found",
  notFoundDescription:
    "This price list could not be found or the link is out of date.",
  loadingLabel: "Loading price list",
  errors: {
    nameRequired: "Enter a price list name",
    nameTooLong: "Name is too long",
    priceInvalid: "Check the highlighted prices",
    ...writeErrorsEn,
    validation: "Check the highlighted fields",
    offline: "No connection. Try again when you are online.",
    permission: "You do not have permission to change price lists.",
  },
};

const ukForm: PricingFormCopy = {
  createTitle: "Новий прайс-лист",
  editTitle: "Редагувати прайс-лист",
  aboutTitle: "Про лист",
  nameLabel: "Назва",
  namePlaceholder: "Наприклад, Опт",
  statusTitle: "Статус",
  defaultLabel: "Основний прайс-лист",
  defaultDescription: "Ним користуються клієнти без власного призначення",
  activeLabel: "Активний",
  inactiveLabel: "Неактивний",
  activeDescriptionOn: "Бере участь у розрахунку цін",
  activeDescriptionOff: "Пропускається під час розрахунку цін",
  defaultAlwaysActive: "Основний лист завжди активний",
  pricesTitle: "Ціни товарів",
  createPricesHint:
    "Після створення ви зможете задати окремі ціни для товарів. Поки поле порожнє — діє базова ціна з каталогу.",
  emptyPriceHint: "Порожня ціна береться з каталогу",
  productSearchLabel: "Пошук товарів",
  productSearchPlaceholder: "Шукати товари…",
  bulkLabel: "Масова знижка",
  bulkPlaceholder: "Знижка %",
  bulkApply: "Застосувати",
  bulkInvalid: "Введіть знижку від 1 до 100%",
  bulkApplied: "Знижку {{percent}}% застосовано до всіх товарів",
  catalogBaseLabel: "Базова ціна {{price}}",
  archivedBadge: "Архівний",
  expandVariants: "Показати варіанти",
  collapseVariants: "Сховати варіанти",
  variantInheritHint: "Порожнє наслідує ціну товару в цьому листі, далі ланцюг",
  noProducts: "Товарів не знайдено.",
  pricesLoading: "Завантаження товарів",
  ...formChromeUk,
  cannotDeactivateDefault: "Спочатку зніміть позначку «основний»",
  submitCreateLoading: "Створення…",
  permissionCreateTitle: "Немає права створювати",
  permissionCreateDescription:
    "Можна переглядати прайс-листи, але не створювати їх.",
  permissionEditTitle: "Немає права редагувати",
  permissionEditDescription:
    "Можна переглядати прайс-листи, але не змінювати їх.",
  notFoundTitle: "Прайс-лист не знайдено",
  notFoundDescription: "Можливо, його було видалено або посилання застаріло.",
  loadingLabel: "Завантаження прайс-листа",
  errors: {
    nameRequired: "Вкажіть назву прайс-листа",
    nameTooLong: "Назва занадто довга",
    priceInvalid: "Перевірте виділені ціни",
    ...writeErrorsUk,
    validation: "Перевірте виділені поля",
    offline: "Немає зʼєднання. Спробуйте, коли зʼявиться мережа.",
    permission: "Немає права змінювати прайс-листи.",
  },
};

const en: SharedPricingCopy = {
  title: "Price lists",
  searchLabel: "Search price lists",
  searchPlaceholder: "Name",
  createLabel: "New price list",
  backLabel: "Back",
  editLabel: "Edit",
  optionsLabel: "Options for {{name}}",
  defaultBadge: "Default",
  inactiveBadge: "Inactive",
  loadingLabel: "Loading price lists",
  loadingMoreLabel: "Loading more",
  hint: "Customers and groups take prices from their assigned list. If none — from the default, then the catalog.",
  filters: {
    all: "All",
    active: "Active",
    inactive: "Inactive",
  },
  prices: {
    none: "No separate prices",
    one: "{{count}} price",
    few: "{{count}} prices",
    many: "{{count}} prices",
  },
  empty: {
    offlineTitle: "No connection",
    offlineDescription: "Check the network and try again.",
    errorTitle: "Could not load price lists",
    errorDescription: "Something went wrong. Try again.",
    retry: "Retry",
    searchTitle: "Nothing found",
    searchDescription: "Change the search or show all price lists.",
    reset: "Reset",
    catalogTitle: "No price lists yet",
    catalogDescription:
      "Create separate prices for wholesale, partners, or seasonal offers.",
    create: "New price list",
  },
  options: {
    setDefault: "Make default",
    clearDefault: "Remove “default” mark",
    activate: "Activate",
    deactivate: "Deactivate",
    delete: "Delete",
    close: "Close",
  },
  confirm: {
    deleteTitle: "Delete this price list?",
    deleteDescription:
      "“{{name}}” and all of its prices will be deleted. Assigned customers and groups will fall back to the next price level.",
    deleteConfirm: "Delete",
    cancel: "Cancel",
  },
  toast: {
    cannotDeactivateDefault: "Assign another default price list first",
  },
  mutation: {
    error: "Could not update the price list. Try again.",
    offline: "No connection. Try again when you are online.",
    permission: "You do not have permission to change price lists.",
  },
  form: enForm,
};

const uk: SharedPricingCopy = {
  title: "Прайс-листи",
  searchLabel: "Пошук прайс-листів",
  searchPlaceholder: "Назва",
  createLabel: "Новий прайс-лист",
  backLabel: "Назад",
  editLabel: "Редагувати",
  optionsLabel: "Опції {{name}}",
  defaultBadge: "Основний",
  inactiveBadge: "Неактивний",
  loadingLabel: "Завантаження прайс-листів",
  loadingMoreLabel: "Завантаження ще",
  hint: "Клієнти й групи беруть ціни з призначеного листа. Якщо його немає — з основного, далі з каталогу.",
  filters: {
    all: "Усі",
    active: "Активні",
    inactive: "Неактивні",
  },
  prices: {
    none: "Без окремих цін",
    one: "{{count}} ціна",
    few: "{{count}} ціни",
    many: "{{count}} цін",
  },
  empty: {
    offlineTitle: "Немає зʼєднання",
    offlineDescription: "Перевірте мережу і спробуйте ще раз.",
    errorTitle: "Не вдалося завантажити прайс-листи",
    errorDescription: "Щось пішло не так. Спробуйте ще раз.",
    retry: "Повторити",
    searchTitle: "Нічого не знайдено",
    searchDescription: "Змініть пошук або покажіть усі прайс-листи.",
    reset: "Скинути",
    catalogTitle: "Прайс-листів ще немає",
    catalogDescription:
      "Створіть окремі ціни для опту, партнерів або сезонних акцій.",
    create: "Новий прайс-лист",
  },
  options: {
    setDefault: "Зробити основним",
    clearDefault: "Прибрати позначку «основний»",
    activate: "Активувати",
    deactivate: "Деактивувати",
    delete: "Видалити",
    close: "Закрити",
  },
  confirm: {
    deleteTitle: "Видалити прайс-лист?",
    deleteDescription:
      "«{{name}}» і всі ціни в ньому буде видалено. Призначені клієнти й групи перейдуть на наступний рівень цін.",
    deleteConfirm: "Видалити",
    cancel: "Скасувати",
  },
  toast: {
    cannotDeactivateDefault: "Спочатку призначте інший основний прайс-лист",
  },
  mutation: {
    error: "Не вдалося оновити прайс-лист. Спробуйте ще раз.",
    offline: "Немає зʼєднання. Спробуйте, коли зʼявиться мережа.",
    permission: "Немає права змінювати прайс-листи.",
  },
  form: ukForm,
};

export function sharedPricingCopy(locale: Locale): SharedPricingCopy {
  return selectCopy(locale, { uk, en });
}
