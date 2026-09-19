import type { CalibrationCase } from "../case.js";

export const CASES: readonly CalibrationCase[] = [
  {
    id: "customers_list_customers-01",
    split: "tune",
    group: "customers_list_customers",
    trait: "direct",
    message: "Знайди клієнта: Наталія Бойко.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Наталія Бойко" },
    },
  },
  {
    id: "customers_list_customers-02",
    split: "holdout",
    group: "customers_list_customers",
    trait: "direct",
    message: "Покажи всіх клієнтів.",
    expected: { tool: "customers_list_customers", args: {} },
  },
  {
    id: "customers_list_customers-03",
    split: "tune",
    group: "customers_list_customers",
    trait: "direct",
    message: "Чи є в базі клієнт Василь Кравченко?",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Василь Кравченко" },
    },
  },
  {
    id: "customers_list_customers-04",
    split: "tune",
    group: "customers_list_customers",
    trait: "direct",
    message: "Пошук клієнта за прізвищем Олійник.",
    expected: { tool: "customers_list_customers", args: { search: "Олійник" } },
  },
  {
    id: "customers_list_customers-05",
    split: "holdout",
    group: "customers_list_customers",
    trait: "direct",
    message: "Find customer Dmytro Lysenko.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Dmytro Lysenko" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Дмитро Лисенко" } },
    ],
  },
  {
    id: "customers_list_customers-06",
    split: "tune",
    group: "customers_list_customers",
    trait: "direct",
    message: "Відкрий список клієнтів.",
    expected: { tool: "customers_list_customers", args: {} },
  },
  {
    id: "customers_list_customers-07",
    split: "holdout",
    group: "customers_list_customers",
    trait: "direct",
    message: "Знайди клієнта з номером 067 123 45 67.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "0671234567" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "+380671234567" } },
      { tool: "customers_list_customers", args: { search: "067 123 45 67" } },
    ],
  },
  {
    id: "customers_list_customers-08",
    split: "tune",
    group: "customers_list_customers",
    trait: "direct",
    message: "Є у нас клієнт ФОП Бондаренко?",
    expected: {
      tool: "customers_list_customers",
      args: { search: "ФОП Бондаренко" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Бондаренко" } },
    ],
  },
  {
    id: "customers_list_customers-09",
    split: "tune",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "клієнти всі покажи",
    expected: { tool: "customers_list_customers", args: {} },
  },
  {
    id: "customers_list_customers-10",
    split: "holdout",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "руденко сергій знайди",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Сергій Руденко" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Руденко Сергій" } },
    ],
  },
  {
    id: "customers_list_customers-11",
    split: "tune",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "глянь чи є в клієнтах мороз галина",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Галина Мороз" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Мороз Галина" } },
    ],
  },
  {
    id: "customers_list_customers-12",
    split: "tune",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "клієнт поліщук пошукай",
    expected: { tool: "customers_list_customers", args: { search: "Поліщук" } },
  },
  {
    id: "customers_list_customers-13",
    split: "holdout",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "найди кліента гриценко світлана",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Світлана Гриценко" },
    },
    alsoOk: [
      {
        tool: "customers_list_customers",
        args: { search: "Гриценко Світлана" },
      },
    ],
  },
  {
    id: "customers_list_customers-14",
    split: "tune",
    group: "customers_list_customers",
    trait: "colloquial",
    message: "база клієнтів",
    expected: { tool: "customers_list_customers", args: {} },
  },
  {
    id: "customers_list_customers-15",
    split: "tune",
    group: "customers_list_customers",
    trait: "inflected",
    message: "Знайди Олену Петренко.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Олена Петренко" },
    },
  },
  {
    id: "customers_list_customers-16",
    split: "holdout",
    group: "customers_list_customers",
    trait: "inflected",
    message: "Пошукай у клієнтах Романа Захарченка.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Роман Захарченко" },
    },
  },
  {
    id: "customers_list_customers-17",
    split: "tune",
    group: "customers_list_customers",
    trait: "inflected",
    message: "Чи є в нас Катруся Павленко серед клієнтів?",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Катерина Павленко" },
    },
    alsoOk: [
      {
        tool: "customers_list_customers",
        args: { search: "Катруся Павленко" },
      },
      { tool: "customers_list_customers", args: { search: "Павленко" } },
    ],
  },
  {
    id: "customers_list_customers-18",
    split: "holdout",
    group: "customers_list_customers",
    trait: "inflected",
    message: "Знайди клієнтку Марту Гулак-Артемовську.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Марта Гулак-Артемовська" },
    },
  },
  {
    id: "customers_list_customers-19",
    split: "tune",
    group: "customers_list_customers",
    trait: "inflected",
    message: "Покажи картку ТОВ «Галицький хліб» у клієнтах.",
    expected: {
      tool: "customers_list_customers",
      args: { search: 'ТОВ "Галицький хліб"' },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Галицький хліб" } },
      {
        tool: "customers_getCustomer",
        args: { customerQuery: "Галицький хліб" },
      },
    ],
  },
  {
    id: "customers_list_customers-20",
    split: "tune",
    group: "customers_list_customers",
    trait: "trap",
    message: "Знайди групу клієнтів «Оптовики».",
    expected: { tool: "customers_list_groups", args: { search: "Оптовики" } },
  },
  {
    id: "customers_list_customers-21",
    split: "holdout",
    group: "customers_list_customers",
    trait: "trap",
    message: "Клієнта Володимира Клименка в базі ще немає, додай.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Володимир Клименко" },
    },
  },
  {
    id: "customers_list_customers-22",
    split: "tune",
    group: "customers_list_customers",
    trait: "trap",
    message: "Знайди контрагента ПП «Будсервіс».",
    expected: {
      tool: "customers_list_counterparties",
      args: { search: 'ПП "Будсервіс"' },
    },
    alsoOk: [
      { tool: "customers_list_counterparties", args: { search: "Будсервіс" } },
    ],
  },
  {
    id: "customers_list_customers-23",
    split: "holdout",
    group: "customers_list_customers",
    trait: "trap",
    message: "Знайди замовлення Людмили Остапенко.",
    expected: {
      tool: "orders_list_page",
      args: { customerQuery: "Людмила Остапенко" },
    },
    alsoOk: [
      {
        tool: "customers_list_customers",
        args: { search: "Людмила Остапенко" },
      },
      { tool: "search_query", args: { query: "Людмила Остапенко" } },
    ],
  },
  {
    id: "customers_list_customers-24",
    split: "tune",
    group: "customers_list_customers",
    trait: "trap",
    message: "Видали клієнта Ярослава Данилюка.",
    expected: {
      tool: "customers_deleteCustomer",
      args: { customerQuery: "Ярослав Данилюк" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Ярослав Данилюк" } },
    ],
  },
  {
    id: "customers_list_customers-25",
    split: "tune",
    group: "customers_list_customers",
    trait: "unsupported",
    message: "Покажи клієнтів, яких додали цього місяця.",
    expected: {
      tool: "customers_list_customers",
      args: { createdPeriod: "this_month" },
    },
  },
  {
    id: "customers_list_customers-26",
    split: "holdout",
    group: "customers_list_customers",
    trait: "unsupported",
    message: "Знайди всіх клієнтів зі Львова.",
    expected: { tool: "customers_list_customers", args: { city: "Львів" } },
  },
  {
    id: "customers_list_customers-27",
    split: "tune",
    group: "customers_list_customers",
    trait: "unsupported",
    message: "Покажи перших десять клієнтів за алфавітом.",
    expected: {
      tool: "customers_list_customers",
      args: { limit: "10", sort: "name" },
    },
  },
  {
    id: "customers_list_customers-28",
    split: "holdout",
    group: "customers_list_customers",
    trait: "unsupported",
    message: "Знайди клієнта з поштою t.kuzmenko@example.com",
    expected: {
      tool: "customers_list_customers",
      args: { email: "t.kuzmenko@example.com" },
    },
    alsoOk: [
      {
        tool: "customers_list_customers",
        args: { search: "t.kuzmenko@example.com" },
      },
    ],
  },
];
