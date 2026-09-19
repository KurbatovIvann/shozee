import type { CalibrationCase } from "../case.js";

export const CASES: readonly CalibrationCase[] = [
  {
    id: "customers_createCustomer-01",
    split: "tune",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Додай клієнта Євген Сидоренко, телефон +380501112233.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Євген Сидоренко", phone: "+380501112233" },
    },
  },
  {
    id: "customers_createCustomer-02",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Створи нового клієнта: Мирослава Дячук.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Мирослава Дячук" },
    },
  },
  {
    id: "customers_createCustomer-03",
    split: "tune",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Зареєструй клієнта Назар Головко, номер 0931234567.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Назар Головко", phone: "+380931234567" },
    },
  },
  {
    id: "customers_createCustomer-04",
    split: "tune",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Новий клієнт — Валентина Юрченко, тел. 067 555 44 33.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Валентина Юрченко", phone: "+380675554433" },
    },
  },
  {
    id: "customers_createCustomer-05",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Add a new customer: Liubomyr Kushnir, phone +380 63 222 11 00.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Liubomyr Kushnir", phone: "+380632221100" },
    },
  },
  {
    id: "customers_createCustomer-06",
    split: "tune",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Внеси в базу клієнта Орися Войтенко.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Орися Войтенко" },
    },
  },
  {
    id: "customers_createCustomer-07",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Додай клієнта ФОП Шевчук.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "ФОП Шевчук" },
    },
  },
  {
    id: "customers_createCustomer-08",
    split: "tune",
    group: "customers_createCustomer",
    trait: "direct",
    message: "Створи картку клієнта: Геннадій Лозинський, +380971010101.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Геннадій Лозинський", phone: "+380971010101" },
    },
  },
  {
    id: "customers_createCustomer-09",
    split: "tune",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "запиши клієнта бабенко руслан 0504443322",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Руслан Бабенко", phone: "+380504443322" },
    },
    alsoOk: [
      {
        tool: "customers_createCustomer",
        args: { name: "Бабенко Руслан", phone: "+380504443322" },
      },
    ],
  },
  {
    id: "customers_createCustomer-10",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "новий кліент вакуленко інна",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Інна Вакуленко" },
    },
    alsoOk: [
      { tool: "customers_createCustomer", args: { name: "Вакуленко Інна" } },
    ],
  },
  {
    id: "customers_createCustomer-11",
    split: "tune",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "додай в базу зінченко павло тел 380667778899",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Павло Зінченко", phone: "+380667778899" },
    },
    alsoOk: [
      {
        tool: "customers_createCustomer",
        args: { name: "Зінченко Павло", phone: "+380667778899" },
      },
    ],
  },
  {
    id: "customers_createCustomer-12",
    split: "tune",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "клієнтка нова жанна присяжнюк запиши",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Жанна Присяжнюк" },
    },
  },
  {
    id: "customers_createCustomer-13",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "добав клиента тимур ахмедов 098 300 20 10",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Тимур Ахмедов", phone: "+380983002010" },
    },
  },
  {
    id: "customers_createCustomer-14",
    split: "tune",
    group: "customers_createCustomer",
    trait: "colloquial",
    message: "закинь у клієнти ореста дорошенка",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Орест Дорошенко" },
    },
  },
  {
    id: "customers_createCustomer-15",
    split: "tune",
    group: "customers_createCustomer",
    trait: "inflected",
    message: "Додай до клієнтів Уляну Вербицьку, номер 0731239876.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Уляна Вербицька", phone: "+380731239876" },
    },
  },
  {
    id: "customers_createCustomer-16",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "inflected",
    message: "Зареєструй Іллю Нечуя-Левицького як нового клієнта.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Ілля Нечуй-Левицький" },
    },
  },
  {
    id: "customers_createCustomer-17",
    split: "tune",
    group: "customers_createCustomer",
    trait: "inflected",
    message: "Запиши нову клієнтку Настусю Коцюбинську, 0955006070.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Настуся Коцюбинська", phone: "+380955006070" },
    },
    alsoOk: [
      {
        tool: "customers_createCustomer",
        args: { name: "Анастасія Коцюбинська", phone: "+380955006070" },
      },
    ],
  },
  {
    id: "customers_createCustomer-18",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "inflected",
    message: "Внеси ТОВ «Еко-Маркет» у клієнтську базу.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: 'ТОВ "Еко-Маркет"' },
    },
    alsoOk: [
      { tool: "customers_createCustomer", args: { name: "ТОВ «Еко-Маркет»" } },
    ],
  },
  {
    id: "customers_createCustomer-19",
    split: "tune",
    group: "customers_createCustomer",
    trait: "inflected",
    message: "Створи клієнта для пана Северина Голобородька.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Северин Голобородько" },
    },
  },
  {
    id: "customers_createCustomer-20",
    split: "tune",
    group: "customers_createCustomer",
    trait: "trap",
    message: "Перевір, чи додано вже клієнта Філіпа Ткачука.",
    expected: {
      tool: "customers_list_customers",
      args: { search: "Філіп Ткачук" },
    },
  },
  {
    id: "customers_createCustomer-21",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "trap",
    message: "Додай клієнтці Одарці Гаврилюк новий номер телефону 0689990011.",
    expected: {
      tool: "customers_updateCustomer",
      args: { customerQuery: "Одарка Гаврилюк", phone: "+380689990011" },
    },
    alsoOk: [
      { tool: "customers_list_customers", args: { search: "Одарка Гаврилюк" } },
    ],
  },
  {
    id: "customers_createCustomer-22",
    split: "tune",
    group: "customers_createCustomer",
    trait: "trap",
    message: "Додай контрагента ТОВ «Західтранс», ЄДРПОУ 40123456.",
    expected: {
      tool: "customers_createCounterparty",
      args: { name: 'ТОВ "Західтранс"', edrpou: "40123456" },
    },
  },
  {
    id: "customers_createCustomer-23",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "trap",
    message: "Додай нового працівника Кирила Бондаря, його номер 0507771234.",
    expected: {
      tool: "invites_create",
      args: { name: "Кирило Бондар", phone: "+380507771234" },
    },
  },
  {
    id: "customers_createCustomer-24",
    split: "tune",
    group: "customers_createCustomer",
    trait: "trap",
    message: "Додай нового клієнта.",
    expected: null,
  },
  {
    id: "customers_createCustomer-25",
    split: "tune",
    group: "customers_createCustomer",
    trait: "unsupported",
    message:
      "Додай клієнта Едуард Шкляр, email shkliar@example.com, телефон 0661230099.",
    expected: {
      tool: "customers_createCustomer",
      args: {
        name: "Едуард Шкляр",
        phone: "+380661230099",
        email: "shkliar@example.com",
      },
    },
  },
  {
    id: "customers_createCustomer-26",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "unsupported",
    message:
      "Створи клієнта Роксолана Демчук, адреса: Тернопіль, вул. Руська, 12.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Роксолана Демчук", address: "Тернопіль, вул. Руська, 12" },
    },
  },
  {
    id: "customers_createCustomer-27",
    split: "tune",
    group: "customers_createCustomer",
    trait: "unsupported",
    message: "Новий клієнт Златослава Кириленко, примітка: алергія на горіхи.",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Златослава Кириленко", note: "алергія на горіхи" },
    },
  },
  {
    id: "customers_createCustomer-28",
    split: "holdout",
    group: "customers_createCustomer",
    trait: "unsupported",
    message: "Додай клієнта Арсен Величко і одразу в групу «Лояльні».",
    expected: {
      tool: "customers_createCustomer",
      args: { name: "Арсен Величко", groupQuery: "Лояльні" },
    },
  },
];
