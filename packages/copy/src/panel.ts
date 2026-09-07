/**
 * Staff panel-shell copy shared by mobile and web (SHO-481).
 *
 * Not form chrome (`./chrome`). The trees differ (mobile tabs + More
 * sheet vs web sidebar/account chrome). This is the intersection of
 * byte-identical uk+en strings that actually match. Different wording
 * (`tabs.more` "Ще" vs web `more` "Більше", `signOut` "Sign Out" vs
 * "Sign out") and one-app keys stay as typed extensions. Do not invent
 * matching nav IA copy for the other app. Tab keys are string literals
 * — apps map `PanelTab` onto that record; this package must not import
 * app types.
 */
import { selectCopy, type Locale } from "./locale.js";

export type SharedPanelTabKey = "orders" | "products" | "ai" | "customers";

export type SharedPanelCopy = {
  readonly navigation: string;
  readonly moduleTitle: string;
  readonly documents: string;
  readonly priceLists: string;
  readonly tabs: Readonly<Record<SharedPanelTabKey, string>>;
};

const en: SharedPanelCopy = {
  navigation: "Main navigation",
  moduleTitle: "Module in development",
  documents: "Documents",
  priceLists: "Price lists",
  tabs: {
    orders: "Orders",
    products: "Products",
    ai: "Shozik",
    customers: "Customers",
  },
};

const uk: SharedPanelCopy = {
  navigation: "Основна навігація",
  moduleTitle: "Модуль у розробці",
  documents: "Документи",
  priceLists: "Прайс-листи",
  tabs: {
    orders: "Замовлення",
    products: "Товари",
    ai: "Шозік",
    customers: "Клієнти",
  },
};

export function sharedPanelCopy(locale: Locale): SharedPanelCopy {
  return selectCopy(locale, { uk, en });
}
