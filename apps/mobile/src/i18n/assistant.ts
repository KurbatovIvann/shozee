/** Staff assistant (Shozik) copy namespace (uk/en). */
import {
  selectCopy,
  writeErrorsEn,
  writeErrorsUk,
  type CountForms,
} from "./copy";
import type { Locale } from "./locale";

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
  };
};

const en: AssistantCopy = {
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
    listEmptyTitle: "No orders",
    listEmptyDescription: "No orders match this request.",
    openOrders: "Open orders",
    openOrder: "Open order",
    customerMatchTruncated:
      "Customer name matches were truncated. Refine the search or open the list.",
    clipped: "The list was clipped. Open orders to see everything.",
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
  },
};

const uk: AssistantCopy = {
  sheetTitle: "Шозік",
  emptyTitle: "Чим допомогти?",
  emptyDescription:
    "Знайду замовлення, клієнтів і документи. Запис у систему — лише після підтвердження.",
  inputPlaceholder: "Напишіть запит…",
  inputLabel: "Повідомлення асистенту",
  sendLabel: "Надіслати",
  confirmLabel: "Підтвердити",
  dismissLabel: "Скасувати",
  confirmingLabel: "Підтверджую…",
  confirmationTitle: "Потрібне підтвердження",
  choiceTitle: "Оберіть варіант",
  choiceTruncated: "Є ще варіанти. Напишіть точну назву смаку.",
  choiceTruncatedMatch: "Є ще збіги. Напишіть точну назву.",
  choiceExpired: "Цей вибір більше недоступний.",
  choiceClaimed: "Цей вибір уже в процесі. Продовжіть, щоб завершити.",
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
    listEmptyTitle: "Немає замовлень",
    listEmptyDescription: "За цим запитом замовлень немає.",
    openOrders: "Відкрити замовлення",
    openOrder: "Відкрити замовлення",
    customerMatchTruncated:
      "Збіги за імʼям клієнта обрізано. Уточніть запит або відкрийте список.",
    clipped: "Список обрізано. Відкрийте замовлення, щоб побачити все.",
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
    network: "Не вдалося звʼязатися з асистентом. Спробуйте ще раз.",
    unavailable: "Асистент недоступний. Спробуйте ще раз.",
    permission: "Немає права користуватися асистентом.",
    unauthenticated: "Увійдіть знову, щоб продовжити.",
    notConfigured: "Асистент не налаштований.",
  },
};

export function assistantCopy(locale: Locale): AssistantCopy {
  return selectCopy(locale, { uk, en });
}
