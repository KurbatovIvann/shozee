/** Orders list copy namespace (uk/en). Shared strings live in `@showzy/copy/orders`. */
import { interpolate, selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedOrdersCopy, type SharedOrdersCopy } from "@showzy/copy/orders";
import { countPluralForm, type CountForms } from "@showzy/copy/plural";

export type OrdersCountForms = CountForms;

export type OrdersDetailCopy = SharedOrdersCopy["detail"] & {
  readonly completeLabel: string;
};

export type OrdersCreateErrorCopy = SharedOrdersCopy["create"]["errors"];

export type OrdersCreateCopy = SharedOrdersCopy["create"] & {
  readonly addProductsLabel: string;
  readonly productSheetClose: string;
  readonly productSheetAdd: string;
  readonly noVariants: string;
  readonly qtyInput: string;
  readonly removeVisible: string;
  readonly itemsInOrder: string;
  readonly customersError: string;
  readonly productsError: string;
  readonly lookupRetry: string;
};

export type OrdersCopy = Omit<
  SharedOrdersCopy,
  "empty" | "detail" | "create"
> & {
  readonly createLabel: string;
  readonly filterAll: string;
  readonly emptySelection: string;
  readonly empty: SharedOrdersCopy["empty"] & {
    readonly catalogDescription: string;
    readonly catalogAction: string;
  };
  readonly detail: OrdersDetailCopy;
  readonly create: OrdersCreateCopy;
};

type WebOrdersExtension = {
  readonly createLabel: string;
  readonly filterAll: string;
  readonly emptySelection: string;
  readonly empty: {
    readonly catalogDescription: string;
    readonly catalogAction: string;
  };
  readonly detail: {
    readonly completeLabel: string;
  };
  readonly create: {
    readonly addProductsLabel: string;
    readonly productSheetClose: string;
    readonly productSheetAdd: string;
    readonly noVariants: string;
    readonly qtyInput: string;
    readonly removeVisible: string;
    readonly itemsInOrder: string;
    readonly customersError: string;
    readonly productsError: string;
    readonly lookupRetry: string;
  };
};

const extraEn: WebOrdersExtension = {
  createLabel: "+ New",
  filterAll: "All",
  emptySelection: "Select an item",
  empty: {
    catalogDescription:
      "Create the first order yourself, or ask the assistant to do it for you.",
    catalogAction: "New order",
  },
  detail: {
    completeLabel: "Done",
  },
  create: {
    addProductsLabel: "Add products",
    productSheetClose: "Close",
    productSheetAdd: "Add · {{count}}",
    noVariants: "No variants",
    qtyInput: "Quantity for {{name}}",
    removeVisible: "Remove",
    itemsInOrder: "{{countLabel}} in the order",
    customersError: "Could not load customers. Try again.",
    productsError: "Could not load products. Try again.",
    lookupRetry: "Retry",
  },
};

const extraUk: WebOrdersExtension = {
  createLabel: "+ Нове",
  filterAll: "Усі",
  emptySelection: "Оберіть елемент",
  empty: {
    catalogDescription:
      "Створіть перше замовлення вручну або попросіть асистента зробити це за вас.",
    catalogAction: "Нове замовлення",
  },
  detail: {
    completeLabel: "Виконано",
  },
  create: {
    addProductsLabel: "Додати товари",
    productSheetClose: "Закрити",
    productSheetAdd: "Додати · {{count}}",
    noVariants: "Без варіантів",
    qtyInput: "Кількість для {{name}}",
    removeVisible: "Видалити",
    itemsInOrder: "{{countLabel}} у замовленні",
    customersError: "Не вдалося завантажити клієнтів. Спробуйте ще раз.",
    productsError: "Не вдалося завантажити товари. Спробуйте ще раз.",
    lookupRetry: "Повторити",
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

export function orderGroupCountLabel(
  copy: OrdersCopy,
  key: "active" | "closed",
  count: number,
): string {
  return interpolate(copy.groupCount, {
    title: copy.groups[key],
    count: String(count),
  });
}

export function orderItemsInOrderLabel(
  copy: OrdersCopy,
  locale: Locale,
  count: number,
): string {
  const countLabel = interpolate(copy.items[countPluralForm(count, locale)], {
    count: String(count),
  });
  return interpolate(copy.create.itemsInOrder, { countLabel });
}

export function orderVariantMetaLabel(
  copy: OrdersCopy,
  locale: Locale,
  count: number,
): string {
  if (count === 0) {
    return copy.create.noVariants;
  }
  return interpolate(copy.create.variants[countPluralForm(count, locale)], {
    count: String(count),
  });
}
