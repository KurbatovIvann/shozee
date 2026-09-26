import type { CalibrationCase } from "../case.js";

export const CASES: readonly CalibrationCase[] = [
  {
    id: "orders_create-01",
    split: "tune",
    group: "orders_create",
    trait: "direct",
    message:
      "Створи замовлення для клієнта Максим Панченко: 2 капучино і 1 круасан.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Максим Панченко",
        items: ["2×капучино", "1×круасан"],
      },
    },
  },
  {
    id: "orders_create-02",
    split: "holdout",
    group: "orders_create",
    trait: "direct",
    message: "Нове замовлення: Вікторія Гончаренко, 3 еклери.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Вікторія Гончаренко", items: ["3×еклер"] },
    },
  },
  {
    id: "orders_create-03",
    split: "tune",
    group: "orders_create",
    trait: "direct",
    message: "Оформи замовлення на 1 торт «Наполеон» для клієнта Олег Семенюк.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Олег Семенюк", items: ["1×торт Наполеон"] },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: { customerQuery: "Олег Семенюк", items: ["1×Наполеон"] },
      },
    ],
  },
  {
    id: "orders_create-04",
    split: "tune",
    group: "orders_create",
    trait: "direct",
    message: "Створи замовлення: 5 троянд червоних, клієнт Петро Назаренко.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Петро Назаренко", items: ["5×троянда червона"] },
    },
  },
  {
    id: "orders_create-05",
    split: "holdout",
    group: "orders_create",
    trait: "direct",
    message:
      "Create an order for Khrystyna Levchenko: 2 lattes and 1 cheesecake.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Khrystyna Levchenko",
        items: ["2×latte", "1×cheesecake"],
      },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: {
          customerQuery: "Христина Левченко",
          items: ["2×лате", "1×чізкейк"],
        },
      },
    ],
  },
  {
    id: "orders_create-06",
    split: "tune",
    group: "orders_create",
    trait: "direct",
    message: "Замовлення для ТОВ «Ромашка»: 10 багетів і 4 хліби житні.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: 'ТОВ "Ромашка"',
        items: ["10×багет", "4×хліб житній"],
      },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: {
          customerQuery: "Ромашка",
          items: ["10×багет", "4×хліб житній"],
        },
      },
    ],
  },
  {
    id: "orders_create-07",
    split: "holdout",
    group: "orders_create",
    trait: "direct",
    message:
      "Створи замовлення на 2 стільці та 1 стіл дубовий, клієнт Микола Тимошенко.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Микола Тимошенко",
        items: ["2×стілець", "1×стіл дубовий"],
      },
    },
  },
  {
    id: "orders_create-08",
    split: "tune",
    group: "orders_create",
    trait: "direct",
    message: "Запиши замовлення: Софія Романюк, 1 манікюр.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Софія Романюк", items: ["1×манікюр"] },
    },
  },
  {
    id: "orders_create-09",
    split: "tune",
    group: "orders_create",
    trait: "colloquial",
    message: "запиши стельмаху ігорю 2 лате і сирник",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Ігор Стельмах", items: ["2×лате", "1×сирник"] },
    },
  },
  {
    id: "orders_create-10",
    split: "holdout",
    group: "orders_create",
    trait: "colloquial",
    message: "замов для зоряни ковальчук 3 американо",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Зоряна Ковальчук", items: ["3×американо"] },
    },
  },
  {
    id: "orders_create-11",
    split: "tune",
    group: "orders_create",
    trait: "colloquial",
    message: "нове замовленя білоус артем колодки гальмівні 2 шт",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Артем Білоус", items: ["2×гальмівні колодки"] },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: { customerQuery: "Артем Білоус", items: ["2×колодки гальмівні"] },
      },
    ],
  },
  {
    id: "orders_create-12",
    split: "tune",
    group: "orders_create",
    trait: "colloquial",
    message: "оформи чорновол ларисі букет троянд",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Лариса Чорновол", items: ["1×букет троянд"] },
    },
  },
  {
    id: "orders_create-13",
    split: "holdout",
    group: "orders_create",
    trait: "colloquial",
    message:
      "марченко денис шиномонтаж і діагностика ходової запиши замовлення",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Денис Марченко",
        items: ["1×шиномонтаж", "1×діагностика ходової"],
      },
    },
  },
  {
    id: "orders_create-14",
    split: "tune",
    group: "orders_create",
    trait: "colloquial",
    message: "зроби замовлення кафе затишок 20 булочок з корицею",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Затишок", items: ["20×булочка з корицею"] },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: {
          customerQuery: 'Кафе "Затишок"',
          items: ["20×булочка з корицею"],
        },
      },
    ],
  },
  {
    id: "orders_create-15",
    split: "tune",
    group: "orders_create",
    trait: "inflected",
    message: "Створи замовлення для Соломії Яремчук: 2 вареники з картоплею.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Соломія Яремчук",
        items: ["2×вареники з картоплею"],
      },
    },
  },
  {
    id: "orders_create-16",
    split: "holdout",
    group: "orders_create",
    trait: "inflected",
    message: "Оформи Остапові Гнатюку 4 свічки запалювання.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "Остап Гнатюк", items: ["4×свічка запалювання"] },
    },
  },
  {
    id: "orders_create-17",
    split: "tune",
    group: "orders_create",
    trait: "inflected",
    message:
      "Замовлення для Даринки Литвиненко: 1 букет «Весняний» і 3 тюльпани.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Дарина Литвиненко",
        items: ["1×букет Весняний", "3×тюльпан"],
      },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: {
          customerQuery: "Даринка Литвиненко",
          items: ["1×букет Весняний", "3×тюльпан"],
        },
      },
    ],
  },
  {
    id: "orders_create-18",
    split: "holdout",
    group: "orders_create",
    trait: "inflected",
    message: "Запиши на Лесю Тобілевич-Садовську 2 чізкейки та 1 какао.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Леся Тобілевич-Садовська",
        items: ["2×чізкейк", "1×какао"],
      },
    },
  },
  {
    id: "orders_create-19",
    split: "tune",
    group: "orders_create",
    trait: "inflected",
    message: "Зроби замовлення ФОП Мазуру: 6 амортизаторів.",
    expected: {
      tool: "orders_create",
      args: { customerQuery: "ФОП Мазур", items: ["6×амортизатор"] },
    },
  },
  {
    id: "orders_create-20",
    split: "tune",
    group: "orders_create",
    trait: "trap",
    message: "Скасуй замовлення для Віталія Приходька.",
    expected: {
      tool: "orders_cancel",
      args: { customerQuery: "Віталій Приходько" },
    },
    alsoOk: [
      {
        tool: "orders_list_page",
        args: { customerQuery: "Віталій Приходько" },
      },
      {
        tool: "customers_list_customers",
        args: { search: "Віталій Приходько" },
      },
    ],
  },
  {
    id: "orders_create-21",
    split: "holdout",
    group: "orders_create",
    trait: "trap",
    message: "Скільки замовлень ми створили сьогодні?",
    expected: { tool: "orders_list_counts", args: { period: "today" } },
  },
  {
    id: "orders_create-22",
    split: "tune",
    group: "orders_create",
    trait: "trap",
    message: "Клієнт хоче замовити торт, що в нас є з тортів?",
    expected: { tool: "catalog_list_products", args: { query: "торт" } },
  },
  {
    id: "orders_create-23",
    split: "holdout",
    group: "orders_create",
    trait: "trap",
    message: "Створи рахунок для замовлення №915.",
    expected: {
      tool: "documents_createFromOrder",
      args: { orderNumber: "915", type: "invoice" },
    },
  },
  {
    id: "orders_create-24",
    split: "tune",
    group: "orders_create",
    trait: "trap",
    message: "Як створити замовлення з телефону?",
    expected: null,
  },
  {
    id: "orders_create-25",
    split: "tune",
    group: "orders_create",
    trait: "unsupported",
    message:
      "Створи замовлення для Надії Федоренко: 1 медовик, доставка на 25 вересня, коментар «без горіхів».",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Надія Федоренко",
        items: ["1×медовик"],
        deliveryDate: "2026-09-25",
        note: "без горіхів",
      },
    },
  },
  {
    id: "orders_create-26",
    split: "holdout",
    group: "orders_create",
    trait: "unsupported",
    message:
      "Замовлення для готелю «Дністер»: 30 сирників, 20 багетів, 10 макаронів, 15 какао і 5 гранол.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Дністер",
        items: ["30×сирник", "20×багет", "10×макарон", "15×какао", "5×гранола"],
      },
    },
    alsoOk: [
      {
        tool: "orders_create",
        args: {
          customerQuery: 'Готель "Дністер"',
          items: [
            "30×сирник",
            "20×багет",
            "10×макарон",
            "15×какао",
            "5×гранола",
          ],
        },
      },
    ],
  },
  {
    id: "orders_create-27",
    split: "tune",
    group: "orders_create",
    trait: "unsupported",
    message: "Оформи Станіславу Костенку 2 комоди зі знижкою 10%.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Станіслав Костенко",
        items: ["2×комод"],
        discountPercent: "10",
      },
    },
  },
  {
    id: "orders_create-28",
    split: "holdout",
    group: "orders_create",
    trait: "unsupported",
    message:
      "Створи замовлення для Аліни Мартинюк: три піци «Маргарита» по 180 гривень.",
    expected: {
      tool: "orders_create",
      args: {
        customerQuery: "Аліна Мартинюк",
        items: ["3×піца Маргарита"],
        unitPriceMinor: "18000",
      },
    },
  },
];
