/** Orders list copy namespace (uk/en). Shared strings live in `@showzy/copy/orders`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedOrdersCopy, type SharedOrdersCopy } from "@showzy/copy/orders";
import type { CountForms } from "@showzy/copy/plural";

import {
  formChromeEn,
  formChromeUk,
  type FormChromeCopy,
} from "@showzy/copy/chrome";

export type OrdersCountForms = CountForms;

export type OrdersDetailCopy = SharedOrdersCopy["detail"] & {
  readonly backLabel: string;
  readonly offlineTitle: string;
  readonly offlineDescription: string;
  readonly notFoundAction: string;
  readonly completeLabel: string;
  readonly actionsTitle: string;
};

export type OrdersCreateErrorCopy = SharedOrdersCopy["create"]["errors"];

export type OrdersCreateCopy = SharedOrdersCopy["create"] &
  Omit<
    FormChromeCopy,
    | "cancel"
    | "leaveTitle"
    | "leaveDescription"
    | "leaveContinue"
    | "leaveConfirm"
    | "submitCreate"
    | "submitCreateLoading"
  > & {
    readonly backLabel: string;
    readonly addProductsLabel: string;
    readonly addProductsValue: string;
    readonly customerSheetTitle: string;
    readonly variantsSelected: string;
    readonly productSheetDone: string;
    readonly variantsNone: string;
    readonly emptyPositions: string;
    readonly pickerLoadingMoreLabel: string;
    readonly pickerLoadMoreLabel: string;
  };

export type OrdersCopy = Omit<
  SharedOrdersCopy,
  "empty" | "detail" | "create"
> & {
  readonly createLabel: string;
  readonly filterLabel: string;
  readonly filterActiveLabel: string;
  readonly filterTitle: string;
  readonly filterReset: string;
  readonly filterApply: string;
  readonly closeSheet: string;
  readonly loadingMoreLabel: string;
  readonly empty: SharedOrdersCopy["empty"] & {
    readonly offlineTitle: string;
    readonly offlineDescription: string;
    readonly catalogDescription: string;
    readonly create: string;
  };
  readonly detail: OrdersDetailCopy;
  readonly create: OrdersCreateCopy;
};

type MobileOrdersExtension = {
  readonly createLabel: string;
  readonly filterLabel: string;
  readonly filterActiveLabel: string;
  readonly filterTitle: string;
  readonly filterReset: string;
  readonly filterApply: string;
  readonly closeSheet: string;
  readonly loadingMoreLabel: string;
  readonly empty: {
    readonly offlineTitle: string;
    readonly offlineDescription: string;
    readonly catalogDescription: string;
    readonly create: string;
  };
  readonly detail: {
    readonly backLabel: string;
    readonly offlineTitle: string;
    readonly offlineDescription: string;
    readonly notFoundAction: string;
    readonly completeLabel: string;
    readonly actionsTitle: string;
  };
  readonly create: {
    readonly backLabel: string;
    readonly addProductsLabel: string;
    readonly addProductsValue: string;
    readonly changedLabel: string;
    readonly closeSheet: string;
    readonly submitEdit: string;
    readonly submitEditLoading: string;
    readonly customerSheetTitle: string;
    readonly variantsSelected: string;
    readonly productSheetDone: string;
    readonly variantsNone: string;
    readonly emptyPositions: string;
    readonly pickerLoadingMoreLabel: string;
    readonly pickerLoadMoreLabel: string;
  };
};

const extraEn: MobileOrdersExtension = {
  createLabel: "New order",
  filterLabel: "Filters",
  filterActiveLabel: "Filters, {{count}} selected",
  filterTitle: "Filters",
  filterReset: "Reset",
  filterApply: "Show",
  closeSheet: "Close",
  loadingMoreLabel: "Loading more orders",
  empty: {
    offlineTitle: "No connection",
    offlineDescription:
      "The order list is unavailable offline. Connect and try again.",
    catalogDescription:
      "Create the first order manually or ask the assistant to do it.",
    create: "New order",
  },
  detail: {
    backLabel: "Back",
    offlineTitle: "No connection",
    offlineDescription:
      "Order details are unavailable offline. Connect and try again.",
    notFoundAction: "To the order list",
    completeLabel: "Complete",
    actionsTitle: "Actions",
  },
  create: {
    backLabel: "Back",
    addProductsLabel: "Products",
    addProductsValue: "{{count}} in the order",
    changedLabel: formChromeEn.changedLabel,
    closeSheet: formChromeEn.closeSheet,
    submitEdit: formChromeEn.submitEdit,
    submitEditLoading: formChromeEn.submitEditLoading,
    customerSheetTitle: "Choose a customer",
    variantsSelected: "{{count}} selected · {{names}}",
    productSheetDone: "Done · {{count}}",
    variantsNone: "No variants",
    emptyPositions: "No items",
    pickerLoadingMoreLabel: "Loading more",
    pickerLoadMoreLabel: "Load more",
  },
};

const extraUk: MobileOrdersExtension = {
  createLabel: "Нове замовлення",
  filterLabel: "Фільтри",
  filterActiveLabel: "Фільтри, вибрано {{count}}",
  filterTitle: "Фільтри",
  filterReset: "Скинути",
  filterApply: "Показати",
  closeSheet: "Закрити",
  loadingMoreLabel: "Завантаження наступних замовлень",
  empty: {
    offlineTitle: "Немає зʼєднання",
    offlineDescription:
      "Список замовлень недоступний офлайн. Підключіться і спробуйте ще раз.",
    catalogDescription:
      "Створіть перше замовлення вручну або попросіть асистента зробити це за вас.",
    create: "Нове замовлення",
  },
  detail: {
    backLabel: "Назад",
    offlineTitle: "Немає зʼєднання",
    offlineDescription:
      "Деталі замовлення недоступні офлайн. Підключіться і спробуйте ще раз.",
    notFoundAction: "До списку замовлень",
    completeLabel: "Виконано",
    actionsTitle: "Швидкі дії",
  },
  create: {
    backLabel: "Назад",
    addProductsLabel: "Товари",
    addProductsValue: "{{count}} у замовленні",
    changedLabel: formChromeUk.changedLabel,
    closeSheet: formChromeUk.closeSheet,
    submitEdit: formChromeUk.submitEdit,
    submitEditLoading: formChromeUk.submitEditLoading,
    customerSheetTitle: "Оберіть клієнта",
    variantsSelected: "{{count}} вибрано · {{names}}",
    productSheetDone: "Готово · {{count}}",
    variantsNone: "Без варіантів",
    emptyPositions: "Без позицій",
    pickerLoadingMoreLabel: "Завантаження",
    pickerLoadMoreLabel: "Завантажити ще",
  },
};

export function ordersCopy(locale: Locale): OrdersCopy {
  const shared = sharedOrdersCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return {
    ...shared,
    ...extra,
    empty: { ...shared.empty, ...extra.empty },
    detail: { ...shared.detail, ...extra.detail },
    create: { ...shared.create, ...extra.create },
  };
}
