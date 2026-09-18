import {
  IHOR_ID,
  OLENA_ID,
  type ExpectedCall,
  type FollowupCase,
  type FollowupExchange,
  type FollowupToolCall,
} from "./corpus.js";

type OrderStatus = "new" | "confirmed" | "in_progress" | "done" | "canceled";

const call = (tool: string, args: ExpectedCall["args"] = {}): ExpectedCall => ({
  tool,
  args,
});

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
  status: OrderStatus = "new",
): FollowupToolCall => ({
  tool: "orders_list_page",
  input,
  output: {
    rows: [
      { number: 2087, status, totalMinor: "18500", currency: "UAH" },
      { number: 2086, status, totalMinor: "9200", currency: "UAH" },
    ],
    total,
    hasMore: total > 2,
  },
});

interface CustomerRow {
  readonly name: string;
  readonly phone: string;
  readonly id?: string;
}

const customerSearch = (
  search: string,
  rows: readonly CustomerRow[],
): FollowupToolCall => ({
  tool: "customers_list_customers",
  input: { search },
  output: {
    rows: rows.map((row) => ({ ...row, status: "active" })),
    hasMore: false,
  },
});

const productSearch = (
  query: string,
  rows: readonly { readonly name: string; readonly basePriceMinor: string }[],
): FollowupToolCall => ({
  tool: "catalog_list_products",
  input: { query },
  output: {
    rows: rows.map((row) => ({ ...row, currency: "UAH" })),
    hasMore: false,
  },
});

const productCreated = (
  name: string,
  basePriceMinor: string,
): FollowupToolCall => ({
  tool: "catalog_createProduct",
  input: { name, basePriceMinor },
  output: { name, basePriceMinor, currency: "UAH" },
});

const orderCreated = (
  customerQuery: string,
  items: readonly (readonly [string, string])[],
  number: number,
  totalMinor: string,
): FollowupToolCall => ({
  tool: "orders_create",
  input: {
    customerQuery,
    items: items.map(([productQuery, quantityDecimal]) => ({
      productQuery,
      quantityDecimal,
    })),
  },
  output: { number, status: "new", totalMinor },
});

const SEARCH = call("search_query");
const ORDER_LOOKUPS: readonly ExpectedCall[] = [
  call("orders_get"),
  call("orders_list_page"),
  SEARCH,
];

const COUNT_TODAY: FollowupExchange = {
  user: "скільки в нас сьогодні замовлень",
  assistant: "Сьогодні 9 замовлень на 6 300 грн.",
  call: counts({ period: "today" }, 9),
};
const COUNT_WEEK: FollowupExchange = {
  user: "Скільки замовлень за цей тиждень?",
  assistant: "За цей тиждень 58 замовлень на 40 600 грн.",
  call: counts({ period: "this_week" }, 58),
};
const LIST_TODAY: FollowupExchange = {
  user: "Покажи сьогоднішні замовлення",
  assistant: "Ось 14 замовлень за сьогодні.",
  call: page({ period: "today" }, 14),
};
const LIST_MONTH: FollowupExchange = {
  user: "виведи замовлення за цей місяць",
  assistant: "За цей місяць 173 замовлення, показую останні.",
  call: page({ period: "this_month" }, 173),
};
const LIST_NEW: FollowupExchange = {
  user: "Які є нові замовлення?",
  assistant: "Зараз 5 нових замовлень, останні — №2087 і №2086.",
  call: page({ statuses: ["new"] }, 5),
};
const FOUND_SVITLANA: FollowupExchange = {
  user: "знайди клієнтку Світлана Гнатюк",
  assistant: "Знайшов: Світлана Гнатюк, +380 97 410 22 33.",
  call: customerSearch("Світлана Гнатюк", [
    { name: "Світлана Гнатюк", phone: "+380974102233" },
  ]),
};
const FOUND_AMERICANO: FollowupExchange = {
  user: "Почому в нас американо?",
  assistant: "Американо — 50 грн.",
  call: productSearch("американо", [
    { name: "Американо", basePriceMinor: "5000" },
  ]),
};
const LISTED_PRICE_LISTS: FollowupExchange = {
  user: "Які в нас є прайси?",
  assistant: "У вас 3 прайси: Базовий, Для кав'ярень і Акційний.",
  call: {
    tool: "pricing_list_price_lists",
    input: {},
    output: {
      rows: [
        { name: "Базовий", isDefault: true },
        { name: "Для кав'ярень", isDefault: false },
        { name: "Акційний", isDefault: false },
      ],
      hasMore: false,
    },
  },
};

export const FOLLOWUP_HOLDOUT_CASES: readonly FollowupCase[] = [
  {
    id: "h001-period-month-count",
    history: [COUNT_WEEK],
    message: "а за місяць шо там",
    needsHistory: true,
    expected: call("orders_list_counts", { period: "this_month" }),
  },
  {
    id: "h002-period-today-list",
    history: [LIST_MONTH],
    message: "А сьогодні?",
    needsHistory: true,
    expected: call("orders_list_page", { period: "today" }),
  },
  {
    id: "h003-period-week-turnover",
    history: [
      {
        user: "Яка виручка за сьогодні?",
        assistant: "Сьогодні 9 замовлень на 6 300 грн.",
        call: counts({ period: "today" }, 9),
      },
    ],
    message: "ну а з початку тижня скільки набігло",
    needsHistory: true,
    expected: call("orders_list_counts", { period: "this_week" }),
  },
  {
    id: "h004-status-canceled-count",
    history: [
      {
        user: "Скільки підтверджених замовлень висить?",
        assistant: "Зараз 7 підтверджених замовлень.",
        call: counts({ statuses: ["confirmed"] }, 7),
      },
    ],
    message: "а скасованих",
    needsHistory: true,
    expected: call("orders_list_counts", { statuses: ["canceled"] }),
  },
  {
    id: "h005-status-done-list",
    history: [
      {
        user: "покажи замовлення які зараз в роботі",
        assistant: "В роботі 6 замовлень.",
        call: page({ statuses: ["in_progress"] }, 6, "in_progress"),
      },
    ],
    message: "А виконані?",
    needsHistory: true,
    expected: call("orders_list_page", { statuses: ["done"] }),
  },
  {
    id: "h006-status-swap-keeps-today",
    history: [
      {
        user: "скільки нових замовлень за сьогодні",
        assistant: "Сьогодні 4 нових замовлення.",
        call: counts({ period: "today", statuses: ["new"] }, 4),
      },
    ],
    message: "а підтверджених?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "today",
      statuses: ["confirmed"],
    }),
  },
  {
    id: "h007-status-swap-keeps-week-list",
    history: [
      {
        user: "Покажи виконані замовлення за цей тиждень",
        assistant: "За цей тиждень виконано 31 замовлення.",
        call: page({ period: "this_week", statuses: ["done"] }, 31, "done"),
      },
    ],
    message: "тепер скасовані",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_week",
      statuses: ["canceled"],
    }),
  },
  {
    id: "h008-period-keeps-canceled",
    history: [
      {
        user: "Скільки скасованих замовлень за цей тиждень?",
        assistant: "За цей тиждень скасовано 3 замовлення.",
        call: counts({ period: "this_week", statuses: ["canceled"] }, 3),
      },
    ],
    message: "А за місяць?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_month",
      statuses: ["canceled"],
    }),
  },
  {
    id: "h009-period-keeps-new-list",
    history: [
      {
        user: "покажи нові замовлення за сьогодні",
        assistant: "Сьогодні 5 нових замовлень.",
        call: page({ period: "today", statuses: ["new"] }, 5),
      },
    ],
    message: "а за цей тиждень які",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_week",
      statuses: ["new"],
    }),
  },
  {
    id: "h010-period-keeps-done",
    history: [
      {
        user: "Скільки ми виконали замовлень цього місяця?",
        assistant: "Цього місяця виконано 140 замовлень.",
        call: counts({ period: "this_month", statuses: ["done"] }, 140),
      },
    ],
    message: "а сьогодні скільки",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "today",
      statuses: ["done"],
    }),
  },
  {
    id: "h011-period-keeps-in-progress",
    history: [
      FOUND_AMERICANO,
      {
        user: "Скільки замовлень в роботі за сьогодні?",
        assistant: "Сьогодні в роботі 2 замовлення.",
        call: counts({ period: "today", statuses: ["in_progress"] }, 2),
      },
    ],
    message: "а за весь цей тиждень?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["in_progress"],
    }),
  },
  {
    id: "h012-count-to-list-today-new",
    history: [
      {
        user: "скіки нових заказів сьогодні",
        assistant: "Сьогодні 4 нових замовлення.",
        call: counts({ period: "today", statuses: ["new"] }, 4),
      },
    ],
    message: "покажи які саме",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "today",
      statuses: ["new"],
    }),
  },
  {
    id: "h013-count-to-list-in-progress",
    history: [
      {
        user: "Скільки замовлень зараз в роботі?",
        assistant: "В роботі 6 замовлень.",
        call: counts({ statuses: ["in_progress"] }, 6),
      },
    ],
    message: "ану покаж їх",
    needsHistory: true,
    expected: call("orders_list_page", { statuses: ["in_progress"] }),
  },
  {
    id: "h014-list-to-sum-week-confirmed",
    history: [
      {
        user: "Покажи підтверджені замовлення за цей тиждень",
        assistant: "За цей тиждень 23 підтверджених замовлення, ось останні.",
        call: page(
          { period: "this_week", statuses: ["confirmed"] },
          23,
          "confirmed",
        ),
      },
    ],
    message: "а на яку суму це все разом?",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["confirmed"],
    }),
  },
  {
    id: "h015-list-to-sum-canceled",
    history: [
      {
        user: "покажи скасовані замовлення",
        assistant: "Скасованих замовлень 9, показую останні.",
        call: page({ statuses: ["canceled"] }, 9, "canceled"),
      },
    ],
    message: "порахуй загальну суму по них",
    needsHistory: true,
    expected: call("orders_list_counts", { statuses: ["canceled"] }),
  },
  {
    id: "h016-order-for-her",
    history: [FOUND_SVITLANA],
    message: "оформи їй замовлення: 3 американо і 1 чізкейк",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Світлана Гнатюк",
      items: ["3×американо", "1×чізкейк"],
    }),
  },
  {
    id: "h017-order-for-created-him",
    history: [
      {
        user: "запиши нового клієнта Богдан Ткачук 0935556677",
        assistant: "Записав клієнта Богдан Ткачук.",
        call: {
          tool: "customers_createCustomer",
          input: { name: "Богдан Ткачук", phone: "0935556677" },
          output: { name: "Богдан Ткачук", phone: "0935556677" },
        },
      },
    ],
    message: "і зразу йому замовлення 2 багети",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Богдан Ткачук",
      items: ["2×багети"],
    }),
  },
  {
    id: "h018-order-for-this-customer",
    history: [
      {
        user: "Пошукай клієнта з номером 0671234567",
        assistant: "Це Олена Петренко, +380 67 123 45 67.",
        call: customerSearch("0671234567", [
          { id: OLENA_ID, name: "Олена Петренко", phone: "+380671234567" },
        ]),
      },
    ],
    message: "Цьому клієнту замовлення — 1 тірамісу, 2 еспресо",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Олена Петренко",
      items: ["1×тірамісу", "2×еспресо"],
    }),
  },
  {
    id: "h019-update-his-phone",
    history: [
      {
        user: "є в базі Ігор Шевчук?",
        assistant: "Так, є: Ігор Шевчук, +380 50 300 40 50.",
        call: customerSearch("Ігор Шевчук", [
          { id: IHOR_ID, name: "Ігор Шевчук", phone: "+380503004050" },
        ]),
      },
    ],
    message: "поміняй йому телефон на 0934445566",
    needsHistory: true,
    expected: call("customers_updateCustomer"),
    alsoOk: [call("customers_list_customers"), SEARCH],
  },
  {
    id: "h020-same-order-other-customer",
    history: [
      {
        user: "Замовлення для Максима Савчука: 4 лате, 2 брауні",
        assistant: "Створив замовлення №3098 для Максима Савчука на 440 грн.",
        call: orderCreated(
          "Максим Савчук",
          [
            ["лате", "4"],
            ["брауні", "2"],
          ],
          3098,
          "44000",
        ),
      },
    ],
    message: "таке саме ще для Катерини Олійник",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Катерина Олійник",
      items: ["4×лате", "2×брауні"],
    }),
  },
  {
    id: "h021-same-price-beans",
    history: [
      {
        user: "Додай товар Зерно Колумбія 250г за 320 грн",
        assistant: "Додав Зерно Колумбія 250г, 320 грн.",
        call: productCreated("Зерно Колумбія 250г", "32000"),
      },
    ],
    message: "Тепер Зерно Кенія 250г, ціна та сама",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Зерно Кенія 250г",
      basePriceMinor: "32000",
    }),
  },
  {
    id: "h022-another-such-group",
    history: [
      {
        user: "Створи групу клієнтів Офіси Поділ",
        assistant: "Створив групу Офіси Поділ.",
        call: {
          tool: "customers_createGroup",
          input: { name: "Офіси Поділ" },
          output: { name: "Офіси Поділ", memberCount: 0 },
        },
      },
    ],
    message: "І ще одну таку — Офіси Оболонь",
    needsHistory: true,
    expected: call("customers_createGroup", { name: "Офіси Оболонь" }),
  },
  {
    id: "h023-answer-price-digits",
    history: [
      {
        user: "Додай в каталог Медовик",
        assistant: "Яка ціна у товару Медовик?",
      },
    ],
    message: "120",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Медовик",
      basePriceMinor: "12000",
    }),
  },
  {
    id: "h024-answer-price-words",
    history: [
      {
        user: "заведи товар Штрудель яблучний",
        assistant: "Скільки коштує Штрудель яблучний?",
      },
    ],
    message: "дев'яносто п'ять гривень",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Штрудель яблучний",
      basePriceMinor: "9500",
    }),
  },
  {
    id: "h025-answer-group-name",
    history: [
      {
        user: "треба нову групу клієнтів зробити",
        assistant: "Як її назвати?",
      },
    ],
    message: "Корпоративні",
    needsHistory: true,
    expected: call("customers_createGroup", { name: "Корпоративні" }),
  },
  {
    id: "h026-answer-customer-details",
    history: [
      {
        user: "запиши нового клієнта",
        assistant: "Як його звати і який номер телефону?",
      },
    ],
    message: "Дмитро Остапчук 0667778899",
    needsHistory: true,
    expected: call("customers_createCustomer", {
      name: "Дмитро Остапчук",
      phone: "0667778899",
    }),
  },
  {
    id: "h027-answer-phone-only",
    history: [
      {
        user: "Додай клієнтку Ярослава Мороз",
        assistant: "Який у неї номер телефону?",
      },
    ],
    message: "0987654321",
    needsHistory: true,
    expected: call("customers_createCustomer", {
      name: "Ярослава Мороз",
      phone: "0987654321",
    }),
  },
  {
    id: "h028-answer-which-surname",
    history: [
      {
        user: "Замовлення для Степана: 2 еспресо",
        assistant:
          "Є два клієнти: Степан Гуменюк і Степан Гуменний. Для кого з них?",
        call: customerSearch("Степан", [
          { name: "Степан Гуменюк", phone: "+380503334455" },
          { name: "Степан Гуменний", phone: "+380681112299" },
        ]),
      },
    ],
    message: "той що Гуменюк",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Степан Гуменюк",
      items: ["2×еспресо"],
    }),
  },
  {
    id: "h029-answer-which-second",
    history: [
      {
        user: "Оформи Лесі 1 медовик і 2 какао",
        assistant:
          "Знайшов двох: перша — Леся Приходько, друга — Леся Присяжнюк. Котрій оформити?",
        call: customerSearch("Леся", [
          { name: "Леся Приходько", phone: "+380975550011" },
          { name: "Леся Присяжнюк", phone: "+380635550022" },
        ]),
      },
    ],
    message: "другій",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Леся Присяжнюк",
      items: ["1×медовик", "2×какао"],
    }),
  },
  {
    id: "h030-answer-for-whom",
    history: [
      {
        user: "Зроби замовлення на 3 капучино",
        assistant: "Для якого клієнта оформити?",
      },
    ],
    message: "для Зоряни Білик",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Зоряна Білик",
      items: ["3×капучино"],
    }),
  },
  {
    id: "h031-correction-list-not-count",
    history: [COUNT_TODAY],
    message: "та ні, не кількість, список дай",
    needsHistory: true,
    expected: call("orders_list_page", { period: "today" }),
  },
  {
    id: "h032-correction-status",
    history: [
      {
        user: "покажи свіжі замовлення за тиждень",
        assistant: "Ось 11 нових замовлень за цей тиждень.",
        call: page({ period: "this_week", statuses: ["new"] }, 11),
      },
    ],
    message: "ні, я про підтверджені питав",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_week",
      statuses: ["confirmed"],
    }),
  },
  {
    id: "h033-correction-customer",
    history: [
      {
        user: "знайди Остапа Вдовиченка",
        assistant: "Знайшов: Остап Вдовиченко, +380 66 900 12 12.",
        call: customerSearch("Остап Вдовиченко", [
          { name: "Остап Вдовиченко", phone: "+380669001212" },
        ]),
      },
    ],
    message: "не той, мені Вдовенко треба, теж Остап",
    needsHistory: true,
    expected: call("customers_list_customers", { search: "Остап Вдовенко" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h034-add-him-after-empty-search",
    history: [
      {
        user: "Знайди клієнта Роман Поліщук",
        assistant: "Клієнта Роман Поліщук не знайшов.",
        call: customerSearch("Роман Поліщук", []),
      },
    ],
    message: "тоді додай його, телефон 0631234567",
    needsHistory: true,
    expected: call("customers_createCustomer", {
      name: "Роман Поліщук",
      phone: "0631234567",
    }),
  },
  {
    id: "h035-create-group-after-empty-search",
    history: [
      {
        user: "Є в нас група Блогери?",
        assistant: "Групи Блогери немає.",
        call: {
          tool: "customers_list_groups",
          input: { search: "Блогери" },
          output: { rows: [], hasMore: false },
        },
      },
    ],
    message: "ну то створи таку",
    needsHistory: true,
    expected: call("customers_createGroup", { name: "Блогери" }),
  },
  {
    id: "h036-add-product-after-empty-search",
    history: [
      {
        user: "Знайди товар Пампушки з часником",
        assistant: "Товару Пампушки з часником у каталозі немає.",
        call: productSearch("Пампушки з часником", []),
      },
    ],
    message: "добавь тоді, 35 грн",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Пампушки з часником",
      basePriceMinor: "3500",
    }),
  },
  {
    id: "h037-two-back-order-for-her",
    history: [
      {
        user: "Знайди Наталю Романюк",
        assistant: "Знайшов: Наталя Романюк, +380 98 321 00 77.",
        call: customerSearch("Наталя Романюк", [
          { name: "Наталя Романюк", phone: "+380983210077" },
        ]),
      },
      COUNT_WEEK,
    ],
    message: "ага, і оформи їй замовлення: лате 2, штрудель 1",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Наталя Романюк",
      items: ["2×лате", "1×штрудель"],
    }),
  },
  {
    id: "h038-two-back-price-as-cocoa",
    history: [
      {
        user: "Додай товар Какао за 70 грн",
        assistant: "Додав товар Какао, 70 грн.",
        call: productCreated("Какао", "7000"),
      },
      COUNT_TODAY,
    ],
    message: "Додай ще Какао з маршмелоу, ціна як у звичайного",
    needsHistory: true,
    expected: call("catalog_createProduct", {
      name: "Какао з маршмелоу",
      basePriceMinor: "7000",
    }),
  },
  {
    id: "h039-two-back-repeat-order",
    history: [
      {
        user: "Створи замовлення для Катерини Олійник: 2 матча лате, 1 медовик",
        assistant: "Створив замовлення №3104 для Катерини Олійник.",
        call: orderCreated(
          "Катерина Олійник",
          [
            ["матча лате", "2"],
            ["медовик", "1"],
          ],
          3104,
          "31000",
        ),
      },
      LIST_TODAY,
    ],
    message: "повтори те замовлення, тільки для Дмитра Остапчука",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Дмитро Остапчук",
      items: ["2×матча лате", "1×медовик"],
    }),
  },
  {
    id: "h040-two-back-her-not-him",
    history: [
      {
        user: "знайди Вікторію Лисенко",
        assistant: "Знайшов: Вікторія Лисенко, +380 73 808 45 45.",
        call: customerSearch("Вікторія Лисенко", [
          { name: "Вікторія Лисенко", phone: "+380738084545" },
        ]),
      },
      {
        user: "а Юрій Данильченко є?",
        assistant: "Так, є: Юрій Данильченко, +380 95 120 60 60.",
        call: customerSearch("Юрій Данильченко", [
          { name: "Юрій Данильченко", phone: "+380951206060" },
        ]),
      },
    ],
    message: "добре, для неї замовлення: 2 капучино і 1 чізкейк",
    needsHistory: true,
    expected: call("orders_create", {
      customerQuery: "Вікторія Лисенко",
      items: ["2×капучино", "1×чізкейк"],
    }),
  },
  {
    id: "h041-narrow-canceled",
    history: [LIST_TODAY],
    message: "лише скасовані",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "today",
      statuses: ["canceled"],
    }),
  },
  {
    id: "h042-narrow-of-them-done",
    history: [COUNT_WEEK],
    message: "з них тіки виконані",
    needsHistory: true,
    expected: call("orders_list_counts", {
      period: "this_week",
      statuses: ["done"],
    }),
  },
  {
    id: "h043-narrow-in-progress",
    history: [LIST_MONTH],
    message: "залиш тільки ті що в роботі",
    needsHistory: true,
    expected: call("orders_list_page", {
      period: "this_month",
      statuses: ["in_progress"],
    }),
  },
  {
    id: "h044-refresh-new-list",
    history: [LIST_NEW],
    message: "ще раз глянь, може щось прийшло",
    needsHistory: true,
    expected: call("orders_list_page", { statuses: ["new"] }),
  },
  {
    id: "h045-refresh-count",
    history: [COUNT_TODAY],
    message: "онови цифру",
    needsHistory: true,
    expected: call("orders_list_counts", { period: "today" }),
  },
  {
    id: "h046-repeat-customer-search",
    history: [
      {
        user: "знайди клієнта Кузьменко",
        assistant: "Клієнта Кузьменко не знайшов.",
        call: customerSearch("Кузьменко", []),
      },
    ],
    message: "повтори пошук, я його щойно з телефона додала",
    needsHistory: true,
    expected: call("customers_list_customers", { search: "Кузьменко" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h047-confirm-it",
    history: [
      {
        user: "Створи замовлення для Галини Кравець: 2 наполеон",
        assistant: "Створив замовлення №3115 для Галини Кравець.",
        call: orderCreated(
          "Галина Кравець",
          [["наполеон", "2"]],
          3115,
          "19000",
        ),
      },
    ],
    message: "підтверджуй його одразу",
    needsHistory: true,
    expected: call("orders_confirm"),
    alsoOk: [call("orders_get")],
  },
  {
    id: "h048-document-for-it",
    history: [
      {
        user: "замовлення для Павла Зінченка 3 зерно Бразилія 1кг",
        assistant: "Створив замовлення №3120 для Павла Зінченка на 2 850 грн.",
        call: orderCreated(
          "Павло Зінченко",
          [["зерно Бразилія 1кг", "3"]],
          3120,
          "285000",
        ),
      },
    ],
    message: "і накладну по ньому зроби",
    needsHistory: true,
    expected: call("documents_createFromOrder"),
    alsoOk: [call("orders_get")],
  },
  {
    id: "h049-start-it",
    history: [
      {
        user: "Що там по замовленню 2210?",
        assistant: "Замовлення №2210 підтверджене, 3 позиції на 540 грн.",
        call: {
          tool: "orders_get",
          input: { number: 2210 },
          output: {
            number: 2210,
            status: "confirmed",
            totalMinor: "54000",
            currency: "UAH",
          },
        },
      },
    ],
    message: "беремо в роботу",
    needsHistory: true,
    expected: call("orders_start"),
    alsoOk: [call("orders_get")],
  },
  {
    id: "h050-raise-its-price",
    history: [
      {
        user: "скільки в нас брауні коштує",
        assistant: "Брауні — 60 грн.",
        call: productSearch("брауні", [
          { name: "Брауні", basePriceMinor: "6000" },
        ]),
      },
    ],
    message: "підніми йому ціну до 68",
    needsHistory: true,
    expected: call("catalog_updateProduct"),
    alsoOk: [call("catalog_list_products"), SEARCH],
  },
  {
    id: "h051-trap-and-canceled-month",
    history: [COUNT_TODAY],
    message: "А скільки скасованих замовлень за цей місяць?",
    needsHistory: false,
    expected: call("orders_list_counts", {
      period: "this_month",
      statuses: ["canceled"],
    }),
  },
  {
    id: "h052-trap-also-find-customer",
    history: [FOUND_SVITLANA],
    message: "І ще знайди клієнта Галина Кравець",
    needsHistory: false,
    expected: call("customers_list_customers", { search: "Галина Кравець" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h053-trap-now-add-product",
    history: [
      {
        user: "Додай товар Айс лате за 85 грн",
        assistant: "Додав товар Айс лате, 85 грн.",
        call: productCreated("Айс лате", "8500"),
      },
    ],
    message: "Тепер додай товар Узвар за 45 грн",
    needsHistory: false,
    expected: call("catalog_createProduct", {
      name: "Узвар",
      basePriceMinor: "4500",
    }),
  },
  {
    id: "h054-trap-ok-now-done-today",
    history: [LIST_NEW],
    message: "Добре, а тепер покажи виконані замовлення за сьогодні",
    needsHistory: false,
    expected: call("orders_list_page", {
      period: "today",
      statuses: ["done"],
    }),
  },
  {
    id: "h055-trap-not-price-lists-groups",
    history: [LISTED_PRICE_LISTS],
    message: "та не прайси, групи клієнтів покажи",
    needsHistory: false,
    expected: call("customers_list_groups"),
  },
  {
    id: "h056-trap-and-order-for-other",
    history: [FOUND_SVITLANA],
    message: "А для Богдана Ткачука оформи замовлення: 2 американо",
    needsHistory: false,
    expected: call("orders_create", {
      customerQuery: "Богдан Ткачук",
      items: ["2×американо"],
    }),
  },
  {
    id: "h057-trap-now-all-week",
    history: [
      {
        user: "Скільки нових замовлень за цей тиждень?",
        assistant: "За цей тиждень 11 нових замовлень.",
        call: counts({ period: "this_week", statuses: ["new"] }, 11),
      },
    ],
    message: "а тепер скільки всього замовлень за цей тиждень",
    needsHistory: false,
    expected: call("orders_list_counts", { period: "this_week" }),
  },
  {
    id: "h058-trap-and-group",
    history: [
      {
        user: "Створи групу Опт Львів",
        assistant: "Створив групу Опт Львів.",
        call: {
          tool: "customers_createGroup",
          input: { name: "Опт Львів" },
          output: { name: "Опт Львів", memberCount: 0 },
        },
      },
    ],
    message: "І ще групу Сусіди створи",
    needsHistory: false,
    expected: call("customers_createGroup", { name: "Сусіди" }),
  },
  {
    id: "h059-trap-abandoned-question",
    history: [
      {
        user: "додай товар Наполеон",
        assistant: "Яка ціна у товару Наполеон?",
      },
    ],
    message: "Ладно, потім з цим. Покажи нові замовлення",
    needsHistory: false,
    expected: call("orders_list_page", { statuses: ["new"] }),
  },
  {
    id: "h060-trap-ok-then-price-list",
    history: [LISTED_PRICE_LISTS],
    message: "Ок, тоді створи прайс Корпоративний",
    needsHistory: false,
    expected: call("pricing_createPriceList", { name: "Корпоративний" }),
  },
  {
    id: "h061-control-find-product",
    history: [LIST_TODAY],
    message: "Знайди товар матча лате",
    needsHistory: false,
    expected: call("catalog_list_products", { query: "матча лате" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h062-control-in-progress-count",
    history: [FOUND_AMERICANO],
    message: "скіки заказів зараз в роботі",
    needsHistory: false,
    expected: call("orders_list_counts", { statuses: ["in_progress"] }),
  },
  {
    id: "h063-control-add-customer",
    history: [COUNT_WEEK],
    message: "Додай клієнта Степан Гуменюк 0503334455",
    needsHistory: false,
    expected: call("customers_createCustomer", {
      name: "Степан Гуменюк",
      phone: "0503334455",
    }),
  },
  {
    id: "h064-control-all-price-lists",
    history: [
      {
        user: "Додай клієнта Тетяна Марчук",
        assistant: "Додав клієнта Тетяна Марчук.",
        call: {
          tool: "customers_createCustomer",
          input: { name: "Тетяна Марчук" },
          output: { name: "Тетяна Марчук" },
        },
      },
    ],
    message: "покажи всі прайси",
    needsHistory: false,
    expected: call("pricing_list_price_lists"),
  },
  {
    id: "h065-control-order-full",
    history: [
      {
        user: "які групи клієнтів є",
        assistant: "У вас 3 групи: Офіси, Кав'ярні-партнери, Персонал.",
        call: {
          tool: "customers_list_groups",
          input: {},
          output: {
            rows: [
              { name: "Офіси", memberCount: 12 },
              { name: "Кав'ярні-партнери", memberCount: 5 },
              { name: "Персонал", memberCount: 8 },
            ],
            hasMore: false,
          },
        },
      },
    ],
    message: "замовлення для Лесі Приходько 1 наполеон 2 какао",
    needsHistory: false,
    expected: call("orders_create", {
      customerQuery: "Леся Приходько",
      items: ["1×наполеон", "2×какао"],
    }),
  },
  {
    id: "h066-control-confirm-by-number",
    history: [LIST_NEW],
    message: "Підтверди замовлення 2087",
    needsHistory: false,
    expected: call("orders_confirm"),
    alsoOk: ORDER_LOOKUPS,
  },
  {
    id: "h067-control-complete-by-number",
    history: [COUNT_TODAY],
    message: "Замовлення 1876 вже віддали, закрий його як виконане",
    needsHistory: false,
    expected: call("orders_complete"),
    alsoOk: ORDER_LOOKUPS,
  },
  {
    id: "h068-control-find-group",
    history: [FOUND_SVITLANA],
    message: "є у нас група Офіси?",
    needsHistory: false,
    expected: call("customers_list_groups", { search: "Офіси" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h069-control-find-price-list",
    history: [FOUND_AMERICANO],
    message: "знайди прайс Гуртовий",
    needsHistory: false,
    expected: call("pricing_list_price_lists", { query: "Гуртовий" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h070-control-turnover-month",
    history: [FOUND_AMERICANO],
    message: "яка в нас виручка за цей місяць",
    needsHistory: false,
    expected: call("orders_list_counts", { period: "this_month" }),
  },
  {
    id: "h071-no-tool-thanks",
    history: [LIST_TODAY],
    message: "дякую, все супер",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h072-no-tool-praise",
    history: [
      {
        user: "Додай клієнта Остап Вдовенко 0509998877",
        assistant: "Додав клієнта Остап Вдовенко.",
        call: {
          tool: "customers_createCustomer",
          input: { name: "Остап Вдовенко", phone: "0509998877" },
          output: { name: "Остап Вдовенко", phone: "0509998877" },
        },
      },
    ],
    message: "клас, швидко ти",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h073-no-tool-capability",
    history: [COUNT_WEEK],
    message: "слухай а ти вмієш рахунки клієнтам на пошту відправляти?",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h074-no-tool-goodbye",
    history: [LIST_NEW],
    message: "ясно, на сьогодні все, до завтра",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h075-no-tool-remark",
    history: [
      {
        user: "почому в нас зерно Ефіопія 250г",
        assistant: "Зерно Ефіопія 250г — 390 грн.",
        call: productSearch("зерно Ефіопія 250г", [
          { name: "Зерно Ефіопія 250г", basePriceMinor: "39000" },
        ]),
      },
    ],
    message: "ого, дорогувато трохи)) ну ладно",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h076-no-tool-greeting",
    history: [],
    message: "Добрий день!",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h077-no-tool-what-can-you-do",
    history: [],
    message: "шо ти взагалі вмієш робити",
    needsHistory: false,
    expected: null,
  },
  {
    id: "h078-cold-count-today",
    history: [],
    message: "скіки сьогодні замовлень було",
    needsHistory: false,
    expected: call("orders_list_counts", { period: "today" }),
  },
  {
    id: "h079-cold-list-week-new",
    history: [],
    message: "так покажи мені будь ласка нові замовлення за цей тиждень",
    needsHistory: false,
    expected: call("orders_list_page", {
      period: "this_week",
      statuses: ["new"],
    }),
  },
  {
    id: "h080-cold-find-customer",
    history: [],
    message: "Знайди клієнта Кузьменко",
    needsHistory: false,
    expected: call("customers_list_customers", { search: "Кузьменко" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h081-cold-order-words",
    history: [],
    message: "створи замовлення для Максима Савчука три лате і два брауні",
    needsHistory: false,
    expected: call("orders_create", {
      customerQuery: "Максим Савчук",
      items: ["3×лате", "2×брауні"],
    }),
  },
  {
    id: "h082-cold-product-price-words",
    history: [],
    message: "Додай товар Багет французький, сорок дві гривні",
    needsHistory: false,
    expected: call("catalog_createProduct", {
      name: "Багет французький",
      basePriceMinor: "4200",
    }),
  },
  {
    id: "h083-cold-create-group",
    history: [],
    message: "Створи групу клієнтів Персонал",
    needsHistory: false,
    expected: call("customers_createGroup", { name: "Персонал" }),
  },
  {
    id: "h084-cold-create-price-list",
    history: [],
    message: "новий прайс Осінній зроби будь ласка",
    needsHistory: false,
    expected: call("pricing_createPriceList", { name: "Осінній" }),
  },
  {
    id: "h085-cold-order-details",
    history: [],
    message: "покажи деталі замовлення №2042",
    needsHistory: false,
    expected: call("orders_get"),
    alsoOk: [call("orders_list_page"), SEARCH],
  },
  {
    id: "h086-cold-cancel-by-number",
    history: [],
    message: "Скасуй замовлення 1990, клієнт відмовився",
    needsHistory: false,
    expected: call("orders_cancel"),
    alsoOk: ORDER_LOOKUPS,
  },
  {
    id: "h087-cold-find-product",
    history: [],
    message: "є в нас в каталозі айс лате?",
    needsHistory: false,
    expected: call("catalog_list_products", { query: "айс лате" }),
    alsoOk: [SEARCH],
  },
  {
    id: "h088-cold-done-month",
    history: [],
    message: "скільки виконаних замовлень за цей місяць",
    needsHistory: false,
    expected: call("orders_list_counts", {
      period: "this_month",
      statuses: ["done"],
    }),
  },
  {
    id: "h089-cold-list-groups",
    history: [],
    message: "які групи клієнтів у нас є",
    needsHistory: false,
    expected: call("customers_list_groups"),
  },
  {
    id: "h090-cold-add-customer",
    history: [],
    message: "Запиши нового клієнта: Тетяна Марчук, тел 0971002030",
    needsHistory: false,
    expected: call("customers_createCustomer", {
      name: "Тетяна Марчук",
      phone: "0971002030",
    }),
  },
];
