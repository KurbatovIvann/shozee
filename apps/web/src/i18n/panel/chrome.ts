/** Panel chrome / nav copy namespace (uk/en). Shared strings live in `@showzy/copy/panel`. */
import { selectCopy, type Locale } from "@showzy/copy/locale";
import { sharedPanelCopy, type SharedPanelCopy } from "@showzy/copy/panel";

export type MemberRoleCopy = {
  readonly owner: string;
  readonly admin: string;
  readonly manager: string;
  readonly employee: string;
};

export type PanelChromeCopy = {
  readonly mainNav: string;
  readonly mobileNav: string;
  readonly menu: string;
  readonly closeMenu: string;
  readonly backToList: string;
  readonly aiName: string;
  readonly aiHint: string;
  readonly close: string;
  readonly closeAi: string;
  readonly accountMenu: string;
  readonly signOut: string;
  readonly theme: string;
  readonly themeMock: string;
  readonly themeLight: string;
  readonly themeSystem: string;
  readonly themeDark: string;
  readonly myAccount: string;
  readonly myAccountBody: string;
  readonly notifications: string;
  readonly notificationsBody: string;
  readonly keyboard: string;
  readonly keyboardBody: string;
  readonly help: string;
  readonly helpBody: string;
  readonly mockEyebrow: string;
  readonly more: string;
  readonly closeMore: string;
  readonly groupOperations: string;
  readonly groupCustomers: string;
  readonly groupSettings: string;
  readonly moduleTitle: string;
  readonly moduleHint: string;
  readonly detailLabel: string;
  readonly orders: string;
  readonly documents: string;
  readonly products: string;
  readonly customers: string;
  readonly customerGroups: string;
  readonly customerGroupsShort: string;
  readonly counterparties: string;
  readonly invites: string;
  readonly pricing: string;
  readonly pricingShort: string;
  readonly company: string;
  readonly documentsTab: string;
  readonly templatesTab: string;
  readonly companyProfile: string;
  readonly companyLegal: string;
  readonly companyTeam: string;
  readonly roles: MemberRoleCopy;
  readonly accountFallback: string;
};

type WebPanelChromeExtension = {
  readonly mobileNav: string;
  readonly menu: string;
  readonly closeMenu: string;
  readonly backToList: string;
  readonly aiHint: string;
  readonly close: string;
  readonly closeAi: string;
  readonly accountMenu: string;
  readonly signOut: string;
  readonly theme: string;
  readonly themeMock: string;
  readonly themeLight: string;
  readonly themeSystem: string;
  readonly themeDark: string;
  readonly myAccount: string;
  readonly myAccountBody: string;
  readonly notifications: string;
  readonly notificationsBody: string;
  readonly keyboard: string;
  readonly keyboardBody: string;
  readonly help: string;
  readonly helpBody: string;
  readonly mockEyebrow: string;
  readonly more: string;
  readonly closeMore: string;
  readonly groupOperations: string;
  readonly groupCustomers: string;
  readonly groupSettings: string;
  readonly moduleHint: string;
  readonly detailLabel: string;
  readonly customerGroups: string;
  readonly customerGroupsShort: string;
  readonly counterparties: string;
  readonly invites: string;
  readonly pricingShort: string;
  readonly company: string;
  readonly documentsTab: string;
  readonly templatesTab: string;
  readonly companyProfile: string;
  readonly companyLegal: string;
  readonly companyTeam: string;
  readonly roles: MemberRoleCopy;
  readonly accountFallback: string;
};

const extraEn: WebPanelChromeExtension = {
  mobileNav: "Mobile navigation",
  menu: "Menu",
  closeMenu: "Close menu",
  backToList: "Back to list",
  aiHint: "Owner assistant. Stub, no chat yet.",
  close: "Close",
  closeAi: "Close Shozik",
  accountMenu: "Account menu",
  signOut: "Sign out",
  theme: "Theme",
  themeMock: "Mock. Dark theme is a separate product.",
  themeLight: "Light",
  themeSystem: "System",
  themeDark: "Dark",
  myAccount: "My account",
  myAccountBody:
    "Phone, email, and active sessions. This is not the company profile — company stays in the sidebar.",
  notifications: "Notifications",
  notificationsBody:
    "Which events arrive by email and in the browser. Mock only, no real channel yet.",
  keyboard: "Keyboard shortcuts",
  keyboardBody:
    "Panel keyboard navigation. The list will land once chrome is canonical.",
  help: "Help",
  helpBody: "Short guides for the owner. Stub, no external link yet.",
  mockEyebrow: "Mock",
  more: "More",
  closeMore: "Close extra menu",
  groupOperations: "Operations",
  groupCustomers: "Customers",
  groupSettings: "Settings",
  moduleHint: "Pick an item in the list. This section will appear soon.",
  detailLabel: "Details",
  customerGroups: "Customer groups",
  customerGroupsShort: "Groups",
  counterparties: "Counterparties",
  invites: "Invites",
  pricingShort: "Prices",
  company: "Company",
  documentsTab: "Documents",
  templatesTab: "Templates",
  companyProfile: "Profile",
  companyLegal: "Legal details",
  companyTeam: "Team",
  roles: {
    owner: "Owner",
    admin: "Admin",
    manager: "Manager",
    employee: "Employee",
  },
  accountFallback: "Account",
};

const extraUk: WebPanelChromeExtension = {
  mobileNav: "Мобільна навігація",
  menu: "Меню",
  closeMenu: "Закрити меню",
  backToList: "Назад до списку",
  aiHint: "Помічник власника. Макет, без чату.",
  close: "Закрити",
  closeAi: "Закрити Шозік",
  accountMenu: "Меню акаунта",
  signOut: "Вийти",
  theme: "Тема",
  themeMock: "Макет. Темна тема — окремий продукт.",
  themeLight: "Світла",
  themeSystem: "Система",
  themeDark: "Темна",
  myAccount: "Мій акаунт",
  myAccountBody:
    "Телефон, email і активні сесії. Це не профіль компанії — компанія лишається в сайдбарі.",
  notifications: "Сповіщення",
  notificationsBody:
    "Які події приходять на пошту й у браузер. Поки макет, без реального каналу.",
  keyboard: "Клавіатура",
  keyboardBody:
    "Навігація по панелі з клавіатури. Список з’явиться, коли chrome стане каноном.",
  help: "Допомога",
  helpBody: "Короткі гіди для власника. Поки заглушка, без зовнішнього лінку.",
  mockEyebrow: "Макет",
  more: "Більше",
  closeMore: "Закрити додаткове меню",
  groupOperations: "Операції",
  groupCustomers: "Клієнти",
  groupSettings: "Налаштування",
  moduleHint: "Оберіть елемент у списку. Цей розділ незабаром з’явиться.",
  detailLabel: "Деталі",
  customerGroups: "Групи клієнтів",
  customerGroupsShort: "Групи",
  counterparties: "Контрагенти",
  invites: "Запрошення",
  pricingShort: "Прайси",
  company: "Компанія",
  documentsTab: "Документи",
  templatesTab: "Шаблони",
  companyProfile: "Профіль",
  companyLegal: "Реквізити",
  companyTeam: "Команда",
  roles: {
    owner: "Власник",
    admin: "Адмін",
    manager: "Менеджер",
    employee: "Співробітник",
  },
  accountFallback: "Акаунт",
};

export function panelChromeCopy(locale: Locale): PanelChromeCopy {
  const shared = sharedPanelCopy(locale);
  const extra = selectCopy(locale, { uk: extraUk, en: extraEn });
  return composeWebPanelChromeCopy(shared, extra);
}

function composeWebPanelChromeCopy(
  shared: SharedPanelCopy,
  extra: WebPanelChromeExtension,
): PanelChromeCopy {
  return {
    mainNav: shared.navigation,
    aiName: shared.tabs.ai,
    moduleTitle: shared.moduleTitle,
    orders: shared.tabs.orders,
    documents: shared.documents,
    products: shared.tabs.products,
    customers: shared.tabs.customers,
    pricing: shared.priceLists,
    ...extra,
  };
}
