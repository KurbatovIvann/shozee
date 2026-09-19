import type { ExpectedCall } from "../../followup/corpus.js";
import type { CalibrationCase } from "../case.js";

const job = (
  suffix: string,
  split: CalibrationCase["split"],
  message: string,
  expected: ExpectedCall,
  alsoOk?: readonly ExpectedCall[],
): CalibrationCase => ({
  id: `other_jobs-${suffix}`,
  split,
  group: "other_jobs",
  trait: "other_job",
  message,
  expected,
  ...(alsoOk === undefined ? {} : { alsoOk }),
});

export const CASES: readonly CalibrationCase[] = [
  job("01", "tune", "Підтверди замовлення №1051.", {
    tool: "orders_confirm",
    args: { orderNumber: "1051" },
  }),
  job(
    "02",
    "holdout",
    "Підтверди останнє замовлення Олени Кравець.",
    { tool: "orders_confirm", args: { customerQuery: "Олена Кравець" } },
    [
      { tool: "orders_list_page", args: { customerQuery: "Олена Кравець" } },
      { tool: "customers_list_customers", args: { search: "Олена Кравець" } },
    ],
  ),
  job("03", "tune", "Скасуй замовлення 988, клієнт передумав.", {
    tool: "orders_cancel",
    args: { orderNumber: "988", reason: "клієнт передумав" },
  }),
  job("04", "tune", "відміни замовлення номер 1210", {
    tool: "orders_cancel",
    args: { orderNumber: "1210" },
  }),
  job("05", "holdout", "Візьми в роботу замовлення №764.", {
    tool: "orders_start",
    args: { orderNumber: "764" },
  }),
  job(
    "06",
    "tune",
    "починаємо робити замовлення 1333 познач що воно в роботі",
    { tool: "orders_start", args: { orderNumber: "1333" } },
  ),
  job("07", "holdout", "Заверши замовлення №642, клієнт усе забрав.", {
    tool: "orders_complete",
    args: { orderNumber: "642" },
  }),
  job("08", "tune", "Mark order 1178 as done.", {
    tool: "orders_complete",
    args: { orderNumber: "1178" },
  }),
  job("09", "tune", "Що входить у замовлення №1402?", {
    tool: "orders_get",
    args: { orderNumber: "1402" },
  }),
  job("10", "holdout", "відкрий деталі замовлення 557", {
    tool: "orders_get",
    args: { orderNumber: "557" },
  }),
  job("11", "tune", "Сформуй видаткову накладну до замовлення №1290.", {
    tool: "documents_createFromOrder",
    args: { orderNumber: "1290", type: "waybill" },
  }),
  job("12", "holdout", "зроби рахунок-фактуру по замовленню 845", {
    tool: "documents_createFromOrder",
    args: { orderNumber: "845", type: "invoice" },
  }),
  job("13", "tune", "Покажи всі документи за цей місяць.", {
    tool: "documents_list",
    args: { period: "this_month" },
  }),
  job(
    "14",
    "tune",
    "Які накладні ми виписали ТОВ «Смачна хата»?",
    {
      tool: "documents_list",
      args: { type: "waybill", counterpartyQuery: 'ТОВ "Смачна хата"' },
    },
    [
      {
        tool: "customers_list_counterparties",
        args: { search: "Смачна хата" },
      },
      { tool: "customers_list_customers", args: { search: "Смачна хата" } },
    ],
  ),
  job(
    "15",
    "holdout",
    "Надішли клієнту посилання на рахунок №310.",
    { tool: "documents_share", args: { documentNumber: "310" } },
    [{ tool: "documents_list", args: { documentNumber: "310" } }],
  ),
  job(
    "16",
    "tune",
    "Поділись актом №77 з нашим бухгалтером.",
    { tool: "documents_share", args: { documentNumber: "77" } },
    [{ tool: "documents_list", args: { documentNumber: "77" } }],
  ),
  job(
    "17",
    "holdout",
    "Відправ договір №45 на підпис.",
    { tool: "documents_requestSign", args: { documentNumber: "45" } },
    [{ tool: "documents_list", args: { documentNumber: "45" } }],
  ),
  job(
    "18",
    "tune",
    "Запроси підпис накладної №512 у ПП «Вектор Плюс».",
    {
      tool: "documents_requestSign",
      args: { documentNumber: "512", counterpartyQuery: 'ПП "Вектор Плюс"' },
    },
    [{ tool: "documents_list", args: { documentNumber: "512" } }],
  ),
  job(
    "19",
    "tune",
    "Зміни телефон клієнта Григорія Саєнка на 0509998877.",
    {
      tool: "customers_updateCustomer",
      args: { customerQuery: "Григорій Саєнко", phone: "+380509998877" },
    },
    [{ tool: "customers_list_customers", args: { search: "Григорій Саєнко" } }],
  ),
  job(
    "20",
    "holdout",
    "Онови прізвище клієнтки Ніни Ярошенко на Коваленко, вона вийшла заміж.",
    {
      tool: "customers_updateCustomer",
      args: { customerQuery: "Ніна Ярошенко", name: "Ніна Коваленко" },
    },
    [{ tool: "customers_list_customers", args: { search: "Ніна Ярошенко" } }],
  ),
  job(
    "21",
    "tune",
    "Заархівуй клієнта Леонід Шаповал, він більше не замовляє.",
    {
      tool: "customers_archiveCustomer",
      args: { customerQuery: "Леонід Шаповал" },
    },
    [{ tool: "customers_list_customers", args: { search: "Леонід Шаповал" } }],
  ),
  job(
    "22",
    "holdout",
    "Видали з бази клієнта Вадим Кучер, це дубль.",
    {
      tool: "customers_deleteCustomer",
      args: { customerQuery: "Вадим Кучер" },
    },
    [{ tool: "customers_list_customers", args: { search: "Вадим Кучер" } }],
  ),
  job(
    "23",
    "tune",
    "Перейменуй групу «Лікарі» на «Медики».",
    {
      tool: "customers_updateGroup",
      args: { groupQuery: "Лікарі", name: "Медики" },
    },
    [{ tool: "customers_list_groups", args: { search: "Лікарі" } }],
  ),
  job(
    "24",
    "tune",
    "Видали групу клієнтів «Тестова».",
    { tool: "customers_deleteGroup", args: { groupQuery: "Тестова" } },
    [{ tool: "customers_list_groups", args: { search: "Тестова" } }],
  ),
  job(
    "25",
    "holdout",
    "Покажи повну картку клієнтки Емілії Собко з усіма контактами.",
    { tool: "customers_getCustomer", args: { customerQuery: "Емілія Собко" } },
    [{ tool: "customers_list_customers", args: { search: "Емілія Собко" } }],
  ),
  job(
    "26",
    "tune",
    "Додай контрагента ФОП Гуменюк Олександр, ІПН 3012345678.",
    {
      tool: "customers_createCounterparty",
      args: { name: "ФОП Гуменюк Олександр", taxId: "3012345678" },
    },
  ),
  job("27", "holdout", "Покажи список контрагентів.", {
    tool: "customers_list_counterparties",
    args: {},
  }),
  job("28", "tune", "Знайди контрагента з ЄДРПОУ 38765432.", {
    tool: "customers_list_counterparties",
    args: { search: "38765432" },
  }),
  job(
    "29",
    "tune",
    "Перейменуй товар «Пончик» на «Донат».",
    {
      tool: "catalog_updateProduct",
      args: { productQuery: "Пончик", name: "Донат" },
    },
    [{ tool: "catalog_list_products", args: { query: "Пончик" } }],
  ),
  job(
    "30",
    "holdout",
    "постав ціну 58 гривень на флет вайт",
    {
      tool: "catalog_updateProduct",
      args: { productQuery: "флет вайт", basePriceMinor: "5800" },
    },
    [{ tool: "catalog_list_products", args: { query: "флет вайт" } }],
  ),
  job(
    "31",
    "tune",
    "Прибери з продажу сендвіч з куркою, ми його більше не готуємо.",
    {
      tool: "catalog_archiveProduct",
      args: { productQuery: "сендвіч з куркою" },
    },
    [{ tool: "catalog_list_products", args: { query: "сендвіч з куркою" } }],
  ),
  job(
    "32",
    "holdout",
    "Додай до товару «Свічка ароматична» варіант «лаванда» за 190 грн.",
    {
      tool: "catalog_createVariant",
      args: {
        productQuery: "Свічка ароматична",
        name: "лаванда",
        priceMinor: "19000",
      },
    },
    [{ tool: "catalog_list_products", args: { query: "Свічка ароматична" } }],
  ),
  job(
    "33",
    "tune",
    "Покажи всі варіанти й ціни товару «Стіл розкладний».",
    { tool: "catalog_getProduct", args: { productQuery: "Стіл розкладний" } },
    [{ tool: "catalog_list_products", args: { query: "Стіл розкладний" } }],
  ),
  job(
    "34",
    "tune",
    "У прайсі «Дилерський» постав ремінь ГРМ по 850 гривень.",
    {
      tool: "pricing_setPriceListEntries",
      args: {
        priceListQuery: "Дилерський",
        productQuery: "ремінь ГРМ",
        priceMinor: "85000",
      },
    },
    [
      { tool: "pricing_list_price_lists", args: { query: "Дилерський" } },
      { tool: "catalog_list_products", args: { query: "ремінь ГРМ" } },
    ],
  ),
  job(
    "35",
    "holdout",
    "Активуй прайс-лист «Великодній».",
    {
      tool: "pricing_activatePriceList",
      args: { priceListQuery: "Великодній" },
    },
    [{ tool: "pricing_list_price_lists", args: { query: "Великодній" } }],
  ),
  job(
    "36",
    "tune",
    "Зроби прайс «Інтернет-магазин» типовим для всіх нових замовлень.",
    {
      tool: "pricing_setDefaultPriceList",
      args: { priceListQuery: "Інтернет-магазин" },
    },
    [{ tool: "pricing_list_price_lists", args: { query: "Інтернет-магазин" } }],
  ),
  job(
    "37",
    "holdout",
    "Видали прайс-лист «Чорна п'ятниця», акція закінчилась.",
    {
      tool: "pricing_deletePriceList",
      args: { priceListQuery: "Чорна п'ятниця" },
    },
    [{ tool: "pricing_list_price_lists", args: { query: "Чорна п'ятниця" } }],
  ),
  job(
    "38",
    "tune",
    "Які ціни зараз у прайсі «Святковий»?",
    {
      tool: "pricing_listPriceListEntries",
      args: { priceListQuery: "Святковий" },
    },
    [{ tool: "pricing_list_price_lists", args: { query: "Святковий" } }],
  ),
  job("39", "tune", "Запроси в команду Марину Олешко, номер 0671112299.", {
    tool: "invites_create",
    args: { name: "Марина Олешко", phone: "+380671112299" },
  }),
  job(
    "40",
    "holdout",
    "Надішли запрошення новому баристі на пошту barista.ivan@example.com",
    {
      tool: "invites_create",
      args: { email: "barista.ivan@example.com", role: "barista" },
    },
  ),
  job("41", "tune", "Які запрошення працівникам ще не прийняті?", {
    tool: "invites_list",
    args: { status: "pending" },
  }),
  job("42", "holdout", "Покажи реквізити нашої компанії.", {
    tool: "companies_get",
    args: {},
  }),
  job(
    "43",
    "tune",
    "Зміни юридичну адресу компанії на м. Вінниця, вул. Соборна, 8.",
    {
      tool: "companies_updateLegal",
      args: { legalAddress: "м. Вінниця, вул. Соборна, 8" },
    },
    [{ tool: "companies_get", args: {} }],
  ),
  job(
    "44",
    "tune",
    "Онови в реквізитах назву компанії на ФОП Ткаченко Оксана Іванівна.",
    {
      tool: "companies_updateLegal",
      args: { legalName: "ФОП Ткаченко Оксана Іванівна" },
    },
    [{ tool: "companies_get", args: {} }],
  ),
  job("45", "holdout", "Знайди все, що пов'язано з номером 0445012233.", {
    tool: "search_query",
    args: { query: "0445012233" },
  }),
  job(
    "multi-01",
    "tune",
    "Додай клієнта Ігоря Ващука і створи йому замовлення на 2 лате.",
    { tool: "customers_createCustomer", args: { name: "Ігор Ващук" } },
  ),
  job(
    "multi-02",
    "holdout",
    "Створи товар «Морквяний торт» за 90 грн і додай його в прайс «Для кав'ярень».",
    {
      tool: "catalog_createProduct",
      args: { name: "Морквяний торт", basePriceMinor: "9000" },
    },
    [{ tool: "pricing_list_price_lists", args: { query: "Для кав'ярень" } }],
  ),
  job(
    "multi-03",
    "tune",
    "Підтверди замовлення №1501 і сформуй до нього рахунок.",
    { tool: "orders_confirm", args: { orderNumber: "1501" } },
  ),
  job(
    "multi-04",
    "tune",
    "Створи групу «Спортклуби» та прайс-лист «Фітнес».",
    { tool: "customers_createGroup", args: { name: "Спортклуби" } },
    [{ tool: "pricing_createPriceList", args: { name: "Фітнес" } }],
  ),
  job(
    "multi-05",
    "holdout",
    "Знайди клієнтку Аделіну Рибак і покажи її замовлення за цей місяць.",
    { tool: "customers_list_customers", args: { search: "Аделіна Рибак" } },
    [
      {
        tool: "orders_list_page",
        args: { period: "this_month", customerQuery: "Аделіна Рибак" },
      },
    ],
  ),
  job(
    "multi-06",
    "tune",
    "Заверши замовлення 1377 і надішли клієнту накладну.",
    { tool: "orders_complete", args: { orderNumber: "1377" } },
  ),
  job(
    "multi-07",
    "holdout",
    "скільки замовлень сьогодні і ще покажи прайс-листи",
    { tool: "orders_list_counts", args: { period: "today" } },
    [{ tool: "pricing_list_price_lists", args: {} }],
  ),
  job(
    "multi-08",
    "tune",
    "Create a customer Petro Hrytsak and archive the old record Petro Gritsak.",
    { tool: "customers_createCustomer", args: { name: "Petro Hrytsak" } },
    [
      {
        tool: "customers_archiveCustomer",
        args: { customerQuery: "Petro Gritsak" },
      },
      { tool: "customers_list_customers", args: { search: "Petro Gritsak" } },
    ],
  ),
];
