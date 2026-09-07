/**
 * Staff assistant copy (SHO-484).
 *
 * Wholesale move of the mobile assistant tree. Web has no assistant
 * copy today — do not invent web strings here. Result-surface chrome
 * (`ordersList` / `customersList` / `aggregate`) stays on
 * `sharedAssistantCopy` (SHO-472 / SHO-473). Do not rename that API.
 *
 * Write-error spreads come from `./chrome`. Assistant `network` /
 * `unavailable` / `permission` strings intentionally differ from form
 * chrome — do not unify them. Do not import assistant, AI, or contract
 * types.
 */
import { writeErrorsEn, writeErrorsUk } from "./chrome.js";
import { selectCopy, type Locale } from "./locale.js";
import type { CountForms } from "./plural.js";

export type SharedAssistantOrdersListCopy = {
  readonly listEmptyTitle: string;
  readonly listEmptyDescription: string;
  readonly openList: string;
  readonly customerMatchTruncated: string;
  readonly clipped: string;
};

export type SharedAssistantCustomersListCopy = {
  readonly listEmptyTitle: string;
  readonly listEmptyDescription: string;
  readonly openList: string;
  readonly clipped: string;
};

export type SharedAssistantAggregateCopy = {
  readonly totals: string;
  readonly countColumn: string;
  readonly amountColumn: string;
  readonly productColumn: string;
  readonly statusColumn: string;
  readonly customerColumn: string;
};

export type SharedAssistantCopy = {
  readonly ordersList: SharedAssistantOrdersListCopy;
  readonly customersList: SharedAssistantCustomersListCopy;
  readonly aggregate: SharedAssistantAggregateCopy;
};

export type AssistantJobsCopy = {
  readonly orders_list_page: string;
  readonly orders_list_counts: string;
  readonly orders_get: string;
  readonly orders_create: string;
  readonly catalog_list_products: string;
  readonly pricing_list_price_lists: string;
  readonly customers_listCustomers: string;
  readonly fallback: string;
};

export type AssistantCardsCopy = {
  readonly listEmptyTitle: string;
  readonly listEmptyDescription: string;
  readonly openOrders: string;
  readonly openOrder: string;
  readonly customerMatchTruncated: string;
  readonly clipped: string;
  readonly orderCount: CountForms;
  readonly noneBucket: string;
  readonly aggregateEmptyTitle: string;
  readonly aggregateEmptyDescription: string;
  readonly bucketsTruncated: string;
  readonly bucketsOmitted: CountForms;
  readonly periodToday: string;
  readonly periodThisWeek: string;
  readonly periodThisMonth: string;
};

export type AssistantCopy = {
  readonly sheetTitle: string;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly inputPlaceholder: string;
  readonly inputLabel: string;
  readonly sendLabel: string;
  readonly confirmLabel: string;
  readonly dismissLabel: string;
  readonly confirmingLabel: string;
  readonly confirmationTitle: string;
  readonly choiceTitle: string;
  readonly choiceTruncated: string;
  readonly choiceTruncatedMatch: string;
  readonly choiceExpired: string;
  readonly choiceClaimed: string;
  readonly choiceRetry: string;
  readonly choiceSelecting: string;
  readonly waitLabel: string;
  readonly waitIntervalMs: number;
  readonly waitLines: readonly [string, string, string, string, string];
  readonly jobs: AssistantJobsCopy;
  readonly cards: AssistantCardsCopy;
  readonly errors: {
    readonly validation: string;
    readonly network: string;
    readonly offline: string;
    readonly unavailable: string;
    readonly permission: string;
    readonly unauthenticated: string;
    readonly notConfigured: string;
    readonly rateLimited: string;
  };
};

const en: SharedAssistantCopy = {
  ordersList: {
    listEmptyTitle: "No orders",
    listEmptyDescription: "No orders match this request.",
    openList: "Open orders",
    customerMatchTruncated:
      "Customer name matches were truncated. Refine the search or open the list.",
    clipped: "The list was clipped. Open orders to see everything.",
  },
  customersList: {
    listEmptyTitle: "No customers",
    listEmptyDescription: "No customers match this request.",
    openList: "Open customers",
    clipped: "The list was clipped. Open customers to see everything.",
  },
  aggregate: {
    totals: "Total",
    countColumn: "Qty",
    amountColumn: "Amount",
    productColumn: "Product and variant",
    statusColumn: "Status and product",
    customerColumn: "Customer and product",
  },
};

const uk: SharedAssistantCopy = {
  ordersList: {
    listEmptyTitle: "Немає замовлень",
    listEmptyDescription: "За цим запитом замовлень немає.",
    openList: "Відкрити замовлення",
    customerMatchTruncated:
      "Збіги за імʼям клієнта обрізано. Уточни запит або відкрий список.",
    clipped: "Список обрізано. Відкрий замовлення, щоб побачити все.",
  },
  customersList: {
    listEmptyTitle: "Немає клієнтів",
    listEmptyDescription: "За цим запитом клієнтів немає.",
    openList: "Відкрити клієнтів",
    clipped: "Список обрізано. Відкрий клієнтів, щоб побачити все.",
  },
  aggregate: {
    totals: "Разом",
    countColumn: "К-сть",
    amountColumn: "Сума",
    productColumn: "Товар і варіант",
    statusColumn: "Статус і товар",
    customerColumn: "Замовник і товар",
  },
};

const assistantEn: AssistantCopy = {
  sheetTitle: "Shozik",
  emptyTitle: "How can I help?",
  emptyDescription:
    "I can look up orders, customers, and documents. Writes run only after you confirm.",
  inputPlaceholder: "Write a request…",
  inputLabel: "Message to the assistant",
  sendLabel: "Send",
  confirmLabel: "Confirm",
  dismissLabel: "Cancel",
  confirmingLabel: "Confirming…",
  confirmationTitle: "Confirmation required",
  choiceTitle: "Select a variant",
  choiceTruncated: "More variants exist. Reply with the exact flavour name.",
  choiceTruncatedMatch: "More matches exist. Reply with the exact name.",
  choiceExpired: "This choice expired.",
  choiceClaimed: "This choice is already in progress. Continue to finish it.",
  choiceRetry: "Continue",
  choiceSelecting: "Selecting…",
  waitLabel: "Shozik is thinking",
  waitIntervalMs: 2000,
  waitLines: [
    "Digging through the data",
    "Picked up a scent",
    "Sniffing around",
    "One more dig",
    "I'll dig a little more",
  ],
  jobs: {
    orders_list_page: "Looking up orders",
    orders_list_counts: "Counting turnover",
    orders_get: "Opening the order",
    orders_create: "Creating the order",
    catalog_list_products: "Searching the catalog",
    pricing_list_price_lists: "Looking up price lists",
    customers_listCustomers: "Looking up customers",
    fallback: "Working",
  },
  cards: {
    listEmptyTitle: en.ordersList.listEmptyTitle,
    listEmptyDescription: en.ordersList.listEmptyDescription,
    openOrders: en.ordersList.openList,
    openOrder: "Open order",
    customerMatchTruncated: en.ordersList.customerMatchTruncated,
    clipped: en.ordersList.clipped,
    orderCount: {
      one: "{{count}} order",
      few: "{{count}} orders",
      many: "{{count}} orders",
    },
    noneBucket: "Total",
    aggregateEmptyTitle: "No orders",
    aggregateEmptyDescription: "No orders match this request.",
    bucketsTruncated: "Not every group is shown.",
    bucketsOmitted: {
      one: "{{count}} more group is not shown.",
      few: "{{count}} more groups are not shown.",
      many: "{{count}} more groups are not shown.",
    },
    periodToday: "Today",
    periodThisWeek: "This week",
    periodThisMonth: "This month",
  },
  errors: {
    ...writeErrorsEn,
    network: "Could not reach the assistant. Try again.",
    unavailable: "The assistant is unavailable. Try again.",
    permission: "You do not have permission to use the assistant.",
    unauthenticated: "Sign in again to continue.",
    notConfigured: "The assistant is not configured.",
    rateLimited: "Too many requests. Try again later.",
  },
};

const assistantUk: AssistantCopy = {
  sheetTitle: "Шозік",
  emptyTitle: "Чим допомогти?",
  emptyDescription:
    "Знайду замовлення, клієнтів і документи. Запис у систему — лише після підтвердження.",
  inputPlaceholder: "Напиши запит…",
  inputLabel: "Повідомлення асистенту",
  sendLabel: "Надіслати",
  confirmLabel: "Підтвердити",
  dismissLabel: "Скасувати",
  confirmingLabel: "Підтверджую…",
  confirmationTitle: "Потрібне підтвердження",
  choiceTitle: "Обери варіант",
  choiceTruncated: "Є ще варіанти. Напиши точну назву смаку.",
  choiceTruncatedMatch: "Є ще збіги. Напиши точну назву.",
  choiceExpired: "Цей вибір більше недоступний.",
  choiceClaimed: "Цей вибір уже в процесі. Продовжи, щоб завершити.",
  choiceRetry: "Продовжити",
  choiceSelecting: "Обираю…",
  waitLabel: "Шозік думає",
  waitIntervalMs: 2000,
  waitLines: [
    "Копаюсь у даних",
    "Напав на слід",
    "Обнюхую записи",
    "Ще копну",
    "Покопаю ще трошечки",
  ],
  jobs: {
    orders_list_page: "Шукаю замовлення",
    orders_list_counts: "Рахую виторг",
    orders_get: "Відкриваю замовлення",
    orders_create: "Створюю замовлення",
    catalog_list_products: "Шукаю в каталозі",
    pricing_list_price_lists: "Шукаю прайси",
    customers_listCustomers: "Шукаю клієнтів",
    fallback: "Працюю",
  },
  cards: {
    listEmptyTitle: uk.ordersList.listEmptyTitle,
    listEmptyDescription: uk.ordersList.listEmptyDescription,
    openOrders: uk.ordersList.openList,
    openOrder: "Відкрити замовлення",
    customerMatchTruncated: uk.ordersList.customerMatchTruncated,
    clipped: uk.ordersList.clipped,
    orderCount: {
      one: "{{count}} замовлення",
      few: "{{count}} замовлення",
      many: "{{count}} замовлень",
    },
    noneBucket: "Усього",
    aggregateEmptyTitle: "Немає замовлень",
    aggregateEmptyDescription: "За цим запитом замовлень немає.",
    bucketsTruncated: "Показано не всі групи.",
    bucketsOmitted: {
      one: "Ще {{count}} група не показано.",
      few: "Ще {{count}} групи не показано.",
      many: "Ще {{count}} груп не показано.",
    },
    periodToday: "Сьогодні",
    periodThisWeek: "Цього тижня",
    periodThisMonth: "Цього місяця",
  },
  errors: {
    ...writeErrorsUk,
    validation: "Перевір виділені поля.",
    network: "Не вдалося звʼязатися з асистентом. Спробуй ще раз.",
    offline: "Немає зʼєднання. Підключись і спробуй ще раз.",
    unavailable: "Асистент недоступний. Спробуй ще раз.",
    permission: "Немає права користуватися асистентом.",
    unauthenticated: "Увійди знову, щоб продовжити.",
    notConfigured: "Асистент не налаштований.",
    rateLimited: "Забагато запитів. Спробуй пізніше.",
  },
};

export function sharedAssistantCopy(locale: Locale): SharedAssistantCopy {
  return selectCopy(locale, { uk, en });
}

export function assistantCopy(locale: Locale): AssistantCopy {
  return selectCopy(locale, { uk: assistantUk, en: assistantEn });
}
