/**
 * Staff orders copy shared by mobile and web (SHO-414).
 *
 * This is the intersection of byte-identical uk+en strings. Keys that
 * exist in only one app, or that exist in both with different wording,
 * stay in that app as a typed extension of `SharedOrdersCopy`. Do not
 * "harmonise" those leftovers here.
 */
import { selectCopy, type Locale } from "./locale.js";
import type { CountForms } from "./plural.js";

export type SharedOrdersEmptyCopy = {
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly filteredTitle: string;
  readonly filteredDescription: string;
  readonly reset: string;
  readonly catalogTitle: string;
};

export type SharedOrdersDetailCopy = {
  readonly title: string;
  readonly loadingLabel: string;
  readonly errorTitle: string;
  readonly errorDescription: string;
  readonly retry: string;
  readonly notFoundTitle: string;
  readonly notFoundDescription: string;
  readonly customerTitle: string;
  readonly linesTitle: string;
  readonly commentTitle: string;
  readonly dueLabel: string;
  readonly confirmLabel: string;
  readonly startLabel: string;
  readonly cancelOrder: string;
  readonly actionsLabel: string;
  readonly mutationError: string;
  readonly mutationOffline: string;
  readonly mutationPermission: string;
  readonly thumbnailUnavailable: string;
};

export type SharedOrdersCreateErrorCopy = {
  readonly customerRequired: string;
  readonly itemsRequired: string;
  readonly itemsDuplicate: string;
  readonly itemsTooMany: string;
  readonly itemsVariantRequired: string;
  readonly itemsNoActiveVariants: string;
  readonly commentTooLong: string;
  readonly validation: string;
  readonly network: string;
  readonly offline: string;
  readonly unavailable: string;
  readonly permission: string;
};

export type SharedOrdersCreateCopy = {
  readonly title: string;
  readonly itemsTitle: string;
  readonly addProductsPlaceholder: string;
  readonly customerTitle: string;
  readonly customerLabel: string;
  readonly customerPlaceholder: string;
  readonly commentTitle: string;
  readonly commentLabel: string;
  readonly commentPlaceholder: string;
  readonly cancel: string;
  readonly leaveTitle: string;
  readonly leaveDescription: string;
  readonly leaveContinue: string;
  readonly leaveConfirm: string;
  readonly submitCreate: string;
  readonly submitCreateLoading: string;
  readonly permissionTitle: string;
  readonly permissionDescription: string;
  readonly customerSearchPlaceholder: string;
  readonly customerSearchLabel: string;
  readonly productSheetTitle: string;
  readonly productSearchPlaceholder: string;
  readonly productSearchLabel: string;
  readonly variantsBackLabel: string;
  readonly variantsLoading: string;
  readonly variantsError: string;
  readonly thumbnailUnavailable: string;
  readonly qtyDecrease: string;
  readonly qtyIncrease: string;
  readonly removeLine: string;
  readonly variants: CountForms;
  readonly emptyCustomers: string;
  readonly emptyProducts: string;
  readonly emptyVariants: string;
  readonly errors: SharedOrdersCreateErrorCopy;
};

export type SharedOrdersCopy = {
  readonly title: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly filterStatus: string;
  readonly statuses: {
    readonly new: string;
    readonly confirmed: string;
    readonly in_progress: string;
    readonly done: string;
    readonly canceled: string;
  };
  readonly groups: {
    readonly active: string;
    readonly closed: string;
  };
  readonly groupCount: string;
  readonly items: CountForms;
  readonly missingCustomer: string;
  readonly loadingLabel: string;
  readonly empty: SharedOrdersEmptyCopy;
  readonly detail: SharedOrdersDetailCopy;
  readonly create: SharedOrdersCreateCopy;
};

const en: SharedOrdersCopy = {
  title: "Orders",
  searchLabel: "Search orders",
  searchPlaceholder: "Number, customer or phone",
  filterStatus: "Order status",
  statuses: {
    new: "New",
    confirmed: "Confirmed",
    in_progress: "In progress",
    done: "Done",
    canceled: "Canceled",
  },
  groups: {
    active: "Active",
    closed: "Closed",
  },
  groupCount: "{{title}} · {{count}}",
  items: {
    one: "{{count}} item",
    few: "{{count}} items",
    many: "{{count}} items",
  },
  missingCustomer: "Deleted customer",
  loadingLabel: "Loading orders",
  empty: {
    errorTitle: "Could not load orders",
    errorDescription: "Check your connection and try again.",
    retry: "Retry",
    filteredTitle: "Nothing found",
    filteredDescription: "Change the search or filters, or reset them.",
    reset: "Reset search and filters",
    catalogTitle: "No orders yet",
  },
  detail: {
    title: "Order",
    loadingLabel: "Loading order",
    errorTitle: "Could not load the order",
    errorDescription: "Check your connection and try again.",
    retry: "Retry",
    notFoundTitle: "Order not found",
    notFoundDescription: "This order could not be found or is unavailable.",
    customerTitle: "Customer",
    linesTitle: "Items",
    commentTitle: "Comment",
    dueLabel: "Due",
    confirmLabel: "Confirm",
    startLabel: "Start",
    cancelOrder: "Cancel order",
    actionsLabel: "Order actions",
    mutationError: "Could not update the order. Try again.",
    mutationOffline: "No connection. Connect and try again.",
    mutationPermission: "You do not have permission to change this order.",
    thumbnailUnavailable: "Photo unavailable",
  },
  create: {
    title: "New order",
    itemsTitle: "Items",
    addProductsPlaceholder: "Add products to the order",
    customerTitle: "Customer",
    customerLabel: "Customer",
    customerPlaceholder: "Choose a customer",
    commentTitle: "Comment",
    commentLabel: "For internal use",
    commentPlaceholder: "Customer requests, decoration details, and so on",
    cancel: "Cancel",
    leaveTitle: "Leave without saving?",
    leaveDescription: "Your changes will be lost.",
    leaveContinue: "Keep editing",
    leaveConfirm: "Leave without saving",
    submitCreate: "Create",
    submitCreateLoading: "Creating…",
    permissionTitle: "No permission",
    permissionDescription: "You do not have permission to create orders.",
    customerSearchPlaceholder: "Search customers…",
    customerSearchLabel: "Search customers",
    productSheetTitle: "Choose products",
    productSearchPlaceholder: "Search products…",
    productSearchLabel: "Search products",
    variantsBackLabel: "Back to products",
    variantsLoading: "Loading variants…",
    variantsError: "Could not load variants. Try again.",
    thumbnailUnavailable: "Photo unavailable",
    qtyDecrease: "Decrease quantity",
    qtyIncrease: "Increase quantity",
    removeLine: "Remove {{name}}",
    variants: {
      one: "{{count}} variant",
      few: "{{count}} variants",
      many: "{{count}} variants",
    },
    emptyCustomers: "No active customers",
    emptyProducts: "No active products",
    emptyVariants: "No active variants",
    errors: {
      customerRequired: "Choose a customer",
      itemsRequired: "Add at least one product",
      itemsDuplicate: "This product is already on the order.",
      itemsTooMany: "Too many lines. Maximum is 100.",
      itemsVariantRequired: "Choose a variant",
      itemsNoActiveVariants: "This product has no active variants",
      commentTooLong: "Comment is too long",
      validation: "Check the fields and try again.",
      network: "Network error. Check your connection.",
      offline: "You're offline. Check your connection and try again.",
      unavailable: "Something went wrong. Try again.",
      permission: "You do not have permission to create orders.",
    },
  },
};

const uk: SharedOrdersCopy = {
  title: "Замовлення",
  searchLabel: "Пошук замовлень",
  searchPlaceholder: "Номер, клієнт або телефон",
  filterStatus: "Статус замовлення",
  statuses: {
    new: "Нове",
    confirmed: "Підтверджено",
    in_progress: "В роботі",
    done: "Виконано",
    canceled: "Скасовано",
  },
  groups: {
    active: "Активні",
    closed: "Закриті",
  },
  groupCount: "{{title}} · {{count}}",
  items: {
    one: "{{count}} позиція",
    few: "{{count}} позиції",
    many: "{{count}} позицій",
  },
  missingCustomer: "Клієнт видалений",
  loadingLabel: "Завантаження замовлень",
  empty: {
    errorTitle: "Не вдалося завантажити замовлення",
    errorDescription: "Перевірте зʼєднання та спробуйте ще раз.",
    retry: "Повторити",
    filteredTitle: "Нічого не знайдено",
    filteredDescription: "Спробуйте змінити пошук чи фільтри або скинути їх.",
    reset: "Скинути пошук і фільтри",
    catalogTitle: "Замовлень ще немає",
  },
  detail: {
    title: "Замовлення",
    loadingLabel: "Завантаження замовлення",
    errorTitle: "Не вдалося завантажити замовлення",
    errorDescription: "Перевірте зʼєднання та спробуйте ще раз.",
    retry: "Повторити",
    notFoundTitle: "Замовлення не знайдено",
    notFoundDescription: "Не вдалося знайти це замовлення або воно недоступне.",
    customerTitle: "Клієнт",
    linesTitle: "Позиції",
    commentTitle: "Коментар",
    dueLabel: "До сплати",
    confirmLabel: "Підтвердити",
    startLabel: "В роботу",
    cancelOrder: "Скасувати замовлення",
    actionsLabel: "Дії з замовленням",
    mutationError: "Не вдалося оновити замовлення. Спробуйте ще раз.",
    mutationOffline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
    mutationPermission: "Немає дозволу змінювати це замовлення.",
    thumbnailUnavailable: "Фото недоступне",
  },
  create: {
    title: "Нове замовлення",
    itemsTitle: "Товари",
    addProductsPlaceholder: "Додайте товари до замовлення",
    customerTitle: "Клієнт",
    customerLabel: "Клієнт",
    customerPlaceholder: "Оберіть клієнта",
    commentTitle: "Коментар",
    commentLabel: "Для внутрішнього використання",
    commentPlaceholder: "Побажання клієнта, деталі декору тощо",
    cancel: "Скасувати",
    leaveTitle: "Вийти без збереження?",
    leaveDescription: "Внесені зміни буде втрачено.",
    leaveContinue: "Продовжити редагування",
    leaveConfirm: "Вийти без збереження",
    submitCreate: "Створити",
    submitCreateLoading: "Створюємо…",
    permissionTitle: "Немає права",
    permissionDescription: "Немає права створювати замовлення.",
    customerSearchPlaceholder: "Пошук клієнтів…",
    customerSearchLabel: "Пошук клієнтів",
    productSheetTitle: "Оберіть товари",
    productSearchPlaceholder: "Пошук товарів…",
    productSearchLabel: "Пошук товарів",
    variantsBackLabel: "Назад до товарів",
    variantsLoading: "Завантажуємо варіанти…",
    variantsError: "Не вдалося завантажити варіанти. Спробуйте ще раз.",
    thumbnailUnavailable: "Фото недоступне",
    qtyDecrease: "Зменшити кількість",
    qtyIncrease: "Збільшити кількість",
    removeLine: "Видалити {{name}}",
    variants: {
      one: "{{count}} варіант",
      few: "{{count}} варіанти",
      many: "{{count}} варіантів",
    },
    emptyCustomers: "Немає активних клієнтів",
    emptyProducts: "Немає активних товарів",
    emptyVariants: "Немає активних варіантів",
    errors: {
      customerRequired: "Оберіть клієнта",
      itemsRequired: "Додайте хоча б один товар",
      itemsDuplicate: "Цей товар уже є в замовленні.",
      itemsTooMany: "Забагато позицій. Максимум 100.",
      itemsVariantRequired: "Оберіть варіант",
      itemsNoActiveVariants: "У цього товару немає активних варіантів",
      commentTooLong: "Коментар занадто довгий",
      validation: "Перевірте поля і спробуйте ще раз.",
      network: "Помилка мережі. Перевірте зʼєднання.",
      offline: "Немає зʼєднання. Підключіться і спробуйте ще раз.",
      unavailable: "Щось пішло не так. Спробуйте ще раз.",
      permission: "Немає права створювати замовлення.",
    },
  },
};

export function sharedOrdersCopy(locale: Locale): SharedOrdersCopy {
  return selectCopy(locale, { uk, en });
}
