/** Panel shell copy namespace (uk/en). Shared strings live in `@showzy/copy/panel`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedPanelCopy, type SharedPanelCopy } from "@showzy/copy/panel";

import type { PanelTab } from "../components/screens/panel/panel-tabs";

export type MoreCopy = {
  readonly session: string;
  readonly userId: string;
  readonly phone: string;
  readonly email: string;
  readonly companySelector: string;
  readonly signOut: string;
  readonly management: string;
  readonly priceLists: string;
  readonly priceListsDescription: string;
  readonly documents: string;
  readonly documentsDescription: string;
  readonly documentsDisabledHint: string;
  readonly settings: string;
  readonly companySettings: string;
  readonly companySettingsDescription: string;
};

export type PanelCopy = {
  readonly navigation: string;
  readonly tabs: Readonly<Record<PanelTab, string>>;
  readonly placeholderTitle: string;
  readonly placeholderDescription: string;
  readonly more: MoreCopy;
};

type MobilePanelExtension = {
  readonly placeholderDescription: string;
  readonly tabs: {
    readonly more: string;
  };
  readonly more: {
    readonly session: string;
    readonly userId: string;
    readonly phone: string;
    readonly email: string;
    readonly companySelector: string;
    readonly signOut: string;
    readonly management: string;
    readonly priceListsDescription: string;
    readonly documentsDescription: string;
    readonly documentsDisabledHint: string;
    readonly settings: string;
    readonly companySettings: string;
    readonly companySettingsDescription: string;
  };
};

const extraEn: MobilePanelExtension = {
  placeholderDescription: "This section is coming soon.",
  tabs: {
    more: "More",
  },
  more: {
    session: "Session",
    userId: "User ID",
    phone: "Phone",
    email: "Email",
    companySelector: "Active company",
    signOut: "Sign Out",
    management: "Management",
    priceListsDescription: "Different prices for customer groups",
    documentsDescription: "Invoices and delivery notes",
    documentsDisabledHint: "Coming soon",
    settings: "Settings",
    companySettings: "Company settings",
    companySettingsDescription: "Profile and legal requisites",
  },
};

const extraUk: MobilePanelExtension = {
  placeholderDescription: "Цей розділ незабаром з’явиться.",
  tabs: {
    more: "Ще",
  },
  more: {
    session: "Сесія",
    userId: "ID користувача",
    phone: "Телефон",
    email: "Email",
    companySelector: "Активна компанія",
    signOut: "Вийти",
    management: "Керування",
    priceListsDescription: "Різні ціни для груп клієнтів",
    documentsDescription: "Рахунки та видаткові накладні",
    documentsDisabledHint: "Незабаром",
    settings: "Налаштування",
    companySettings: "Налаштування компанії",
    companySettingsDescription: "Профіль і юридичні реквізити",
  },
};

export function panelCopy(locale: Locale): PanelCopy {
  const shared = sharedPanelCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return composeMobilePanelCopy(shared, extra);
}

function composeMobilePanelCopy(
  shared: SharedPanelCopy,
  extra: MobilePanelExtension,
): PanelCopy {
  return {
    navigation: shared.navigation,
    placeholderTitle: shared.moduleTitle,
    placeholderDescription: extra.placeholderDescription,
    tabs: {
      ...shared.tabs,
      ...extra.tabs,
    },
    more: {
      ...extra.more,
      priceLists: shared.priceLists,
      documents: shared.documents,
    },
  };
}
