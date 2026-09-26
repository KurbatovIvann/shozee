import type { CalibrationCase } from "../case.js";

export const CASES: readonly CalibrationCase[] = [
  {
    id: "catalog_createProduct-01",
    split: "tune",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Додай товар «Раф лавандовий» за 85 гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Раф лавандовий", basePriceMinor: "8500" },
    },
  },
  {
    id: "catalog_createProduct-02",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Створи товар: Хліб бездріжджовий, ціна 65,50 грн.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Хліб бездріжджовий", basePriceMinor: "6550" },
    },
  },
  {
    id: "catalog_createProduct-03",
    split: "tune",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Новий товар — Полиця настінна, 1200 грн.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Полиця настінна", basePriceMinor: "120000" },
    },
  },
  {
    id: "catalog_createProduct-04",
    split: "tune",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Додай у каталог послугу «Стрижка чоловіча» за 350 гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Стрижка чоловіча", basePriceMinor: "35000" },
    },
  },
  {
    id: "catalog_createProduct-05",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Add a product: Oat milk latte, price 95 UAH.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Oat milk latte", basePriceMinor: "9500" },
    },
  },
  {
    id: "catalog_createProduct-06",
    split: "tune",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Створи товар «Фільтр повітряний» з ціною 420 грн.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Фільтр повітряний", basePriceMinor: "42000" },
    },
  },
  {
    id: "catalog_createProduct-07",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Додай товар «Листівка вітальна».",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Листівка вітальна" },
    },
  },
  {
    id: "catalog_createProduct-08",
    split: "tune",
    group: "catalog_createProduct",
    trait: "direct",
    message: "Заведи новий товар: Чай зелений, 40 гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Чай зелений", basePriceMinor: "4000" },
    },
  },
  {
    id: "catalog_createProduct-09",
    split: "tune",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "додай товар матча лате 110",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Матча лате", basePriceMinor: "11000" },
    },
  },
  {
    id: "catalog_createProduct-10",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "новий товар пончик 35 грн",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Пончик", basePriceMinor: "3500" },
    },
  },
  {
    id: "catalog_createProduct-11",
    split: "tune",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "закинь в каталог гортензія 250",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Гортензія", basePriceMinor: "25000" },
    },
  },
  {
    id: "catalog_createProduct-12",
    split: "tune",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "товар створи тумба приліжкова 3400 гривень",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Тумба приліжкова", basePriceMinor: "340000" },
    },
  },
  {
    id: "catalog_createProduct-13",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "добав товар антифриз 5л 780грн",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Антифриз 5л", basePriceMinor: "78000" },
    },
    alsoOk: [
      {
        tool: "catalog_createProduct",
        args: { name: "Антифриз 5 л", basePriceMinor: "78000" },
      },
    ],
  },
  {
    id: "catalog_createProduct-14",
    split: "tune",
    group: "catalog_createProduct",
    trait: "colloquial",
    message: "в меню додай борщ за 120",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Борщ", basePriceMinor: "12000" },
    },
  },
  {
    id: "catalog_createProduct-15",
    split: "tune",
    group: "catalog_createProduct",
    trait: "inflected",
    message:
      "Додай до каталогу «Пиріг з вишнею та заварним кремом» по 95 гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: {
        name: "Пиріг з вишнею та заварним кремом",
        basePriceMinor: "9500",
      },
    },
  },
  {
    id: "catalog_createProduct-16",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "inflected",
    message: "Створи нову позицію — тістечко «Картопля», ціна 48 грн 50 коп.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: 'Тістечко "Картопля"', basePriceMinor: "4850" },
    },
    alsoOk: [
      {
        tool: "catalog_createProduct",
        args: { name: "Тістечко «Картопля»", basePriceMinor: "4850" },
      },
      {
        tool: "catalog_createProduct",
        args: { name: "Тістечко Картопля", basePriceMinor: "4850" },
      },
    ],
  },
  {
    id: "catalog_createProduct-17",
    split: "tune",
    group: "catalog_createProduct",
    trait: "inflected",
    message: "Внеси в товари послугу заміни масла за 600 гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Заміна масла", basePriceMinor: "60000" },
    },
  },
  {
    id: "catalog_createProduct-18",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "inflected",
    message: "Додай у продаж шафу-купе «Модерн» за 18900 грн.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: 'Шафа-купе "Модерн"', basePriceMinor: "1890000" },
    },
    alsoOk: [
      {
        tool: "catalog_createProduct",
        args: { name: "Шафа-купе «Модерн»", basePriceMinor: "1890000" },
      },
      {
        tool: "catalog_createProduct",
        args: { name: "Шафа-купе Модерн", basePriceMinor: "1890000" },
      },
    ],
  },
  {
    id: "catalog_createProduct-19",
    split: "tune",
    group: "catalog_createProduct",
    trait: "inflected",
    message: "Заведи нам гранолу з горіхами й медом, коштує 140.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Гранола з горіхами й медом", basePriceMinor: "14000" },
    },
  },
  {
    id: "catalog_createProduct-20",
    split: "tune",
    group: "catalog_createProduct",
    trait: "trap",
    message: "Перевір, чи додано вже товар «Сироп карамельний».",
    expected: {
      tool: "catalog_list_products",
      args: { query: "Сироп карамельний" },
    },
  },
  {
    id: "catalog_createProduct-21",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "trap",
    message: "Додай варіант «великий» до товару «Лимонад».",
    expected: {
      tool: "catalog_createVariant",
      args: { productQuery: "Лимонад", name: "великий" },
    },
    alsoOk: [{ tool: "catalog_list_products", args: { query: "Лимонад" } }],
  },
  {
    id: "catalog_createProduct-22",
    split: "tune",
    group: "catalog_createProduct",
    trait: "trap",
    message: "Додай ціну 70 гривень на какао у прайс-лист «Зимовий».",
    expected: {
      tool: "pricing_setPriceListEntries",
      args: {
        priceListQuery: "Зимовий",
        productQuery: "какао",
        priceMinor: "7000",
      },
    },
    alsoOk: [
      { tool: "pricing_list_price_lists", args: { query: "Зимовий" } },
      { tool: "catalog_list_products", args: { query: "какао" } },
    ],
  },
  {
    id: "catalog_createProduct-23",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "trap",
    message: "Підніми ціну на стрижку дитячу до 400 гривень.",
    expected: {
      tool: "catalog_updateProduct",
      args: { productQuery: "стрижка дитяча", basePriceMinor: "40000" },
    },
    alsoOk: [
      { tool: "catalog_list_products", args: { query: "стрижка дитяча" } },
    ],
  },
  {
    id: "catalog_createProduct-24",
    split: "tune",
    group: "catalog_createProduct",
    trait: "trap",
    message: "Додай у каталог новий товар.",
    expected: null,
  },
  {
    id: "catalog_createProduct-25",
    split: "tune",
    group: "catalog_createProduct",
    trait: "unsupported",
    message:
      "Створи товар «Футболка з логотипом» з розмірами S, M, L за 450 грн.",
    expected: {
      tool: "catalog_createProduct",
      args: {
        name: "Футболка з логотипом",
        basePriceMinor: "45000",
        variants: ["S", "M", "L"],
      },
    },
  },
  {
    id: "catalog_createProduct-26",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "unsupported",
    message:
      "Додай товар «Мед липовий», ціна 220 грн, опис: зібраний на Поділлі, банка 0,5 л.",
    expected: {
      tool: "catalog_createProduct",
      args: {
        name: "Мед липовий",
        basePriceMinor: "22000",
        description: "зібраний на Поділлі, банка 0,5 л",
      },
    },
  },
  {
    id: "catalog_createProduct-27",
    split: "tune",
    group: "catalog_createProduct",
    trait: "unsupported",
    message: "Додай товар «Сир твердий» за 380 гривень за кілограм.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Сир твердий", basePriceMinor: "38000", unit: "кг" },
    },
  },
  {
    id: "catalog_createProduct-28",
    split: "holdout",
    group: "catalog_createProduct",
    trait: "unsupported",
    message: "Створи товар «Диван кутовий» за дванадцять тисяч гривень.",
    expected: {
      tool: "catalog_createProduct",
      args: { name: "Диван кутовий", basePriceMinor: "1200000" },
    },
  },
];
