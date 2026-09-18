import type { JSONValue } from "ai";

export interface FollowupToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output: JSONValue;
}

export interface FollowupExchange {
  readonly user: string;
  readonly assistant: string;
  readonly call?: FollowupToolCall;
}

export const OLENA_ID = "0b6f1c1e-5a53-4a0e-9d2c-1f2e3a4b5c6d";
export const IHOR_ID = "7c2d9e4f-8b1a-4c3d-a5e6-9f8e7d6c5b4a";
export const KNOWN_CUSTOMER_NAMES: Readonly<Record<string, string>> = {
  [OLENA_ID]: "Олена Петренко",
  [IHOR_ID]: "Ігор Шевчук",
};

const counts = (
  input: FollowupToolCall["input"],
  total: number,
): FollowupToolCall => ({
  tool: "orders_list_counts",
  input,
  output: { total, totalMinor: String(total * 70_000), currency: "UAH" },
});
const page = (
  input: FollowupToolCall["input"],
  total: number,
): FollowupToolCall => ({
  tool: "orders_list_page",
  input,
  output: {
    rows: [
      { number: 1042, status: "new", totalMinor: "13000", currency: "UAH" },
      { number: 1041, status: "done", totalMinor: "26000", currency: "UAH" },
    ],
    total,
    hasMore: total > 2,
  },
});

export interface ExpectedCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, string | readonly string[]>>;
}

export interface FollowupCase {
  readonly id: string;
  readonly history: readonly FollowupExchange[];
  readonly message: string;
  readonly needsHistory: boolean;
  readonly expected: ExpectedCall | null;
  readonly alsoOk?: readonly ExpectedCall[];
}

const call = (tool: string, args: ExpectedCall["args"] = {}): ExpectedCall => ({
  tool,
  args,
});

const COUNT_TODAY: FollowupExchange = {
  user: "Скільки замовлень сьогодні?",
  assistant: "Сьогодні 12 замовлень на 8 400 грн.",
  call: counts({ period: "today" }, 12),
};
const LIST_TODAY: FollowupExchange = {
  user: "Покажи замовлення за сьогодні",
  assistant: "Ось 12 замовлень за сьогодні.",
  call: page({ period: "today" }, 12),
};
const FOUND_OLENA: FollowupExchange = {
  user: "Знайди клієнта Олена Петренко",
  assistant: "Знайшов: Олена Петренко, +380 67 123 45 67.",
  call: {
    tool: "customers_list_customers",
    input: { search: "Олена Петренко" },
    output: {
      rows: [
        {
          id: OLENA_ID,
          name: "Олена Петренко",
          phone: "+380671234567",
          status: "active",
        },
      ],
      hasMore: false,
    },
  },
};

export const FOLLOWUP_CASES: readonly FollowupCase[] = [
  {
    id: "f01-period-week",
    history: [COUNT_TODAY],
    message: "А за цей тиждень?",
    needsHistory: true,
    expected: call("orders_list_counts", { period: "this_week" }),
  },
  {
    id: "f02-period-month-list",
    history: [LIST_TODAY],
    message: "А за місяць?",
    needsHistory: true,
    expected: call("orders_list_page", { period: "this_month" }),
  },
  {
    id: "f03-status-swap",
    history: [
      {
        user: "Скільки нових замовлень?",
        assistant: "Зараз 5 нових замовлень.",
        call: counts({ statuses: ["new"] }, 5),
      },
    ],
    message: "А підтверджених?",
    needsHistory: true,
    expected: call("orders_list_counts", { statuses: ["confirmed"] }),
  },
  {
    id: "f04-period-keeps-status",
    history: [
      {
        user: "Скільки нових замовлень сьогодні?",
        assistant: "Сьогодні 3 нових замовлення.",
        call: counts({ period: "today", statuses: ["new"] }, 3),
      },
    ],
    message: "А за тиждень?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["new"],
    }),
  },
  {
    id: "f05-count-to-list",
    history: [
      {
        user: "Скільки скасованих замовлень цього місяця?",
        assistant: "Цього місяця скасовано 4 замовлення.",
        call: counts({ period: "this_month", statuses: ["canceled"] }, 4),
      },
    ],
    message: "Покажи їх",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_month",
      statuses: ["canceled"],
    }),
  },
  {
    id: "f06-order-for-her",
    history: [FOUND_OLENA],
    message: "Створи для неї замовлення: 2 капучино",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Олена Петренко",
      items: ["2×капучино"],
    }),
  },
  {
    id: "f07-order-for-him",
    history: [
      {
        user: "Додай клієнта Ігор Шевчук, телефон 0671234567",
        assistant: "Додав клієнта Ігор Шевчук.",
        call: {
          tool: "customers_createCustomer",
          input: { name: "Ігор Шевчук", phone: "0671234567" },
          output: { id: IHOR_ID, name: "Ігор Шевчук" },
        },
      },
    ],
    message: "Тепер замовлення для нього: 3 лате і 1 круасан",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Ігор Шевчук",
      items: ["3×лате", "1×круасан"],
    }),
  },
  {
    id: "f08-product-swap",
    history: [
      {
        user: "Знайди товар капучино",
        assistant: "Є Капучино, 65 грн.",
        call: {
          tool: "catalog_list_products",
          input: { query: "капучино" },
          output: {
            rows: [
              { name: "Капучино", basePriceMinor: "6500", currency: "UAH" },
            ],
            hasMore: false,
          },
        },
      },
    ],
    message: "А лате?",
    needsHistory: true,
    expected: call("catalog_list_products", { query: "лате" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "f09-customer-swap",
    history: [
      {
        user: "Знайди клієнта Марія Бондар",
        assistant: "Знайшов: Марія Бондар, +380 50 222 33 44.",
        call: {
          tool: "customers_list_customers",
          input: { search: "Марія Бондар" },
          output: {
            rows: [{ name: "Марія Бондар", phone: "+380502223344" }],
            hasMore: false,
          },
        },
      },
    ],
    message: "А Тараса Мельника?",
    needsHistory: true,
    expected: call("customers_list_customers", { search: "Тарас Мельник" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "f10-group-among",
    history: [
      {
        user: "Покажи групи клієнтів",
        assistant: "У вас 6 груп клієнтів.",
        call: {
          tool: "customers_list_groups",
          input: {},
          output: {
            rows: [
              { name: "VIP", memberCount: 4 },
              { name: "Постійні", memberCount: 31 },
            ],
            hasMore: true,
          },
        },
      },
    ],
    message: "А є серед них Оптовики?",
    needsHistory: true,
    expected: call("customers_list_groups", { search: "Оптовики" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "f11-correction-period",
    history: [COUNT_TODAY],
    message: "Ні, я мав на увазі за тиждень",
    needsHistory: true,
    expected: call("orders_list_counts", { period: "this_week" }),
  },
  {
    id: "f12-answer-price",
    history: [
      {
        user: "Додай товар Лате",
        assistant: "Яка ціна у товару Лате?",
      },
    ],
    message: "65 гривень",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Лате",
      basePriceMinor: "6500",
    }),
  },
  {
    id: "f13-answer-group-name",
    history: [
      { user: "Створи групу клієнтів", assistant: "Як назвати групу?" },
    ],
    message: "Постійні",
    needsHistory: true,
    expected: call("customers_createGroup", { name: "Постійні" }),
  },
  {
    id: "f14-answer-price-list-name",
    history: [{ user: "Створи прайс", assistant: "Яка назва прайсу?" }],
    message: "Зимовий",
    needsHistory: true,
    expected: call("pricing_createPriceList", { name: "Зимовий" }),
  },
  {
    id: "f15-answer-customer-details",
    history: [
      {
        user: "Додай клієнта",
        assistant: "Як звати клієнта і який у нього телефон?",
      },
    ],
    message: "Андрій Коваль, 0501112233",
    needsHistory: true,
    expected: call("customers_createCustomer", {
      name: "Андрій Коваль",
      phone: "0501112233",
    }),
  },
  {
    id: "f16-again",
    history: [LIST_TODAY],
    message: "Онови, будь ласка",
    needsHistory: true,
    expected: call("orders_list_page", { period: "today" }),
  },
  {
    id: "f17-narrow-status",
    history: [
      {
        user: "Покажи замовлення за цей тиждень",
        assistant: "Ось 40 замовлень за цей тиждень.",
        call: page({ period: "this_week" }, 40),
      },
    ],
    message: "Тільки нові",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_week",
      statuses: ["new"],
    }),
  },
  {
    id: "f18-same-order-other-customer",
    history: [
      {
        user: "Створи замовлення для Олени Петренко: 2 капучино",
        assistant: "Створив замовлення №1042 для Олени Петренко.",
        call: {
          tool: "orders_create",
          input: {
            customerQuery: "Олена Петренко",
            items: [{ productQuery: "капучино", quantityDecimal: "2" }],
          },
          output: { number: 1042, status: "new", totalMinor: "13000" },
        },
      },
    ],
    message: "Ще одне таке саме для Ігоря Шевчука",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Ігор Шевчук",
      items: ["2×капучино"],
    }),
  },
  {
    id: "f19-same-price",
    history: [
      {
        user: "Додай товар Раф за 80 гривень",
        assistant: "Додав товар Раф, 80 грн.",
        call: {
          tool: "catalog_createProduct",
          input: { name: "Раф", basePriceMinor: "8000" },
          output: { name: "Раф", basePriceMinor: "8000", currency: "UAH" },
        },
      },
    ],
    message: "І ще Флет вайт за таку ж ціну",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Флет вайт",
      basePriceMinor: "8000",
    }),
  },
  {
    id: "f20-disambiguate-surname",
    history: [
      {
        user: "Створи замовлення для Олени: 1 лате",
        assistant:
          "Знайшов двох клієнтів: Олена Петренко і Олена Петрук. Для кого замовлення?",
      },
    ],
    message: "Петренко",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Олена Петренко",
      items: ["1×лате"],
    }),
  },
  {
    id: "f21-of-them-done",
    history: [
      {
        user: "Скільки замовлень цього місяця?",
        assistant: "Цього місяця 214 замовлень.",
        call: counts({ period: "this_month" }, 214),
      },
    ],
    message: "А скільки з них виконано?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_month",
      statuses: ["done"],
    }),
  },
  {
    id: "f22-status-swap-list",
    history: [
      {
        user: "Покажи нові замовлення",
        assistant: "Ось 5 нових замовлень.",
        call: page({ statuses: ["new"] }, 5),
      },
    ],
    message: "А в роботі?",
    needsHistory: true,
    expected: call("orders_list_page", { statuses: ["in_progress"] }),
  },
  {
    id: "f23-price-list-among",
    history: [
      {
        user: "Покажи прайси",
        assistant: "У вас 4 прайси.",
        call: {
          tool: "pricing_list_price_lists",
          input: {},
          output: {
            rows: [
              { name: "Роздрібний", isDefault: true },
              { name: "Зимовий", isDefault: false },
            ],
            hasMore: true,
          },
        },
      },
    ],
    message: "А оптовий є?",
    needsHistory: true,
    expected: call("pricing_list_price_lists", { query: "оптовий" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "f24-then-add-him",
    history: [
      {
        user: "Знайди клієнта Назар Коваленко",
        assistant: "Клієнта Назар Коваленко не знайдено.",
        call: {
          tool: "customers_list_customers",
          input: { search: "Назар Коваленко" },
          output: { rows: [], hasMore: false },
        },
      },
    ],
    message: "Тоді додай його, телефон 0931234567",
    needsHistory: true,
    expected: call("customers_createCustomer", {
      name: "Назар Коваленко",
      phone: "0931234567",
    }),
  },
  {
    id: "f25-then-add-product",
    history: [
      {
        user: "Є товар Еспресо?",
        assistant: "Товару Еспресо в каталозі немає.",
        call: {
          tool: "catalog_list_products",
          input: { query: "Еспресо" },
          output: { rows: [], hasMore: false },
        },
      },
    ],
    message: "Додай за 45",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Еспресо",
      basePriceMinor: "4500",
    }),
  },
  {
    id: "f26-one-more-group",
    history: [
      {
        user: "Створи групу VIP",
        assistant: "Створив групу VIP.",
        call: {
          tool: "customers_createGroup",
          input: { name: "VIP" },
          output: { name: "VIP" },
        },
      },
    ],
    message: "І ще одну — Оптовики",
    needsHistory: true,
    expected: call("customers_createGroup", { name: "Оптовики" }),
  },
  {
    id: "c21-and-turnover-month",
    history: [COUNT_TODAY],
    message: "А який оборот за місяць?",
    needsHistory: false,
    expected: call("orders_list_counts", { period: "this_month" }),
  },
  {
    id: "f28-two-back",
    history: [FOUND_OLENA, COUNT_TODAY],
    message: "Зроби їй замовлення на 4 еклери",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Олена Петренко",
      items: ["4×еклери"],
    }),
  },
  {
    id: "f29-and-canceled",
    history: [
      {
        user: "Скільки виконаних замовлень цього тижня?",
        assistant: "Цього тижня виконано 31 замовлення.",
        call: counts({ period: "this_week", statuses: ["done"] }, 31),
      },
    ],
    message: "А скасованих?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["canceled"],
    }),
  },
  {
    id: "f30-show-them-customers",
    history: [
      {
        user: "Скільки у нас клієнтів на прізвище Шевченко?",
        assistant: "Знайшов 3 клієнтів на прізвище Шевченко.",
        call: {
          tool: "customers_list_customers",
          input: { search: "Шевченко" },
          output: {
            rows: [
              { name: "Андрій Шевченко" },
              { name: "Ірина Шевченко" },
              { name: "Петро Шевченко" },
            ],
            hasMore: false,
          },
        },
      },
    ],
    message: "Покажи їх",
    needsHistory: true,
    expected: call("customers_list_customers", { search: "Шевченко" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "c01-switch-find-customer",
    history: [COUNT_TODAY],
    message: "Знайди клієнта Олена Петренко",
    needsHistory: false,
    expected: call("customers_list_customers", { search: "Олена Петренко" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "c02-switch-products",
    history: [FOUND_OLENA],
    message: "Покажи всі товари",
    needsHistory: false,
    expected: call("catalog_list_products", {}),
  },
  {
    id: "c03-switch-count",
    history: [FOUND_OLENA],
    message: "Скільки нових замовлень сьогодні?",
    needsHistory: false,
    expected: call("orders_list_counts", {
      period: "today",
      statuses: ["new"],
    }),
  },
  {
    id: "c04-switch-create-order",
    history: [COUNT_TODAY],
    message: "Створи замовлення для Ігоря Шевчука: 2 лате",
    needsHistory: false,
    expected: call("orders_create", {
      customerQuery: "Ігор Шевчук",
      items: ["2×лате"],
    }),
  },
  {
    id: "c05-switch-create-product",
    history: [LIST_TODAY],
    message: "Додай товар Макаронс за 55 гривень",
    needsHistory: false,
    expected: call("catalog_createProduct", {
      name: "Макаронс",
      basePriceMinor: "5500",
    }),
  },
  {
    id: "c06-switch-create-group",
    history: [COUNT_TODAY],
    message: "Створи групу Оптовики",
    needsHistory: false,
    expected: call("customers_createGroup", { name: "Оптовики" }),
  },
  {
    id: "c07-switch-price-lists",
    history: [FOUND_OLENA],
    message: "Покажи прайси",
    needsHistory: false,
    expected: call("pricing_list_price_lists", {}),
  },
  {
    id: "c08-switch-list-month",
    history: [FOUND_OLENA],
    message: "Покажи замовлення за цей місяць",
    needsHistory: false,
    expected: call("orders_list_page", { period: "this_month" }),
  },
  {
    id: "c09-switch-create-customer",
    history: [LIST_TODAY],
    message: "Додай клієнта Оксана Бондар, телефон 0661234567",
    needsHistory: false,
    expected: call("customers_createCustomer", {
      name: "Оксана Бондар",
      phone: "0661234567",
    }),
  },
  {
    id: "c10-thanks",
    history: [COUNT_TODAY],
    message: "Дякую!",
    needsHistory: false,
    expected: null,
  },
  {
    id: "c11-capabilities",
    history: [LIST_TODAY],
    message: "Що ти вмієш?",
    needsHistory: false,
    expected: null,
  },
  {
    id: "c12-switch-groups",
    history: [COUNT_TODAY],
    message: "Покажи групи клієнтів",
    needsHistory: false,
    expected: call("customers_list_groups", {}),
  },
  {
    id: "c13-switch-done-week",
    history: [FOUND_OLENA],
    message: "Скільки виконаних замовлень цього тижня?",
    needsHistory: false,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["done"],
    }),
  },
  {
    id: "c14-switch-create-price-list",
    history: [COUNT_TODAY],
    message: "Створи прайс Літній",
    needsHistory: false,
    expected: call("pricing_createPriceList", { name: "Літній" }),
  },
  {
    id: "c15-first-count",
    history: [],
    message: "Скільки замовлень за цей тиждень?",
    needsHistory: false,
    expected: call("orders_list_counts", { period: "this_week" }),
  },
  {
    id: "c16-first-find-product",
    history: [],
    message: "Знайди товар круасан",
    needsHistory: false,
    expected: call("catalog_list_products", { query: "круасан" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "c17-first-canceled-list",
    history: [],
    message: "Покажи скасовані замовлення",
    needsHistory: false,
    expected: call("orders_list_page", { statuses: ["canceled"] }),
  },
  {
    id: "c18-first-find-group",
    history: [],
    message: "Знайди групу Постійні",
    needsHistory: false,
    expected: call("customers_list_groups", { search: "Постійні" }),
    alsoOk: [call("search_query")],
  },
  {
    id: "c19-first-hello",
    history: [],
    message: "Привіт!",
    needsHistory: false,
    expected: null,
  },
  {
    id: "c20-first-create-order",
    history: [],
    message: "Створи замовлення для Марії Бондар: 1 еклер і 2 капучино",
    needsHistory: false,
    expected: call("orders_create", {
      customerQuery: "Марія Бондар",
      items: ["1×еклер", "2×капучино"],
    }),
  },
];
