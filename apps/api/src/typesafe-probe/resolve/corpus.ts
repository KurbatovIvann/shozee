export const RESOLVE_PICKER = "picker";
export const RESOLVE_NONE = "none";

export const VARIABLE_PRODUCTS: Readonly<Record<string, readonly string[]>> = {
  Макаронси: ["Ваніль", "Лаванда", "Лимон", "Малина", "Фісташка", "Шоколад"],
  "Торт бісквітний": ["Полуничний", "Шоколадний", "Карамельний"],
  "Футболка з логотипом": ["S", "M", "L"],
  "Чай листовий": ["Чорний", "Зелений", "Трав'яний"],
};

export interface ResolveLine {
  readonly product: string;
  readonly variant?: string;
  readonly quantity: string;
}

export interface ResolveCase {
  readonly id: string;
  readonly trait: string;
  readonly message: string;
  readonly customer: string;
  readonly lines: readonly ResolveLine[];
}

const line = (
  quantity: string,
  product: string,
  variant?: string,
): ResolveLine => ({
  quantity,
  product,
  ...(variant === undefined ? {} : { variant }),
});

const c = (
  id: string,
  trait: string,
  message: string,
  customer: string,
  ...lines: ResolveLine[]
): ResolveCase => ({ id, trait, message, customer, lines });

export const RESOLVE_CASES: readonly ResolveCase[] = [
  c(
    "exact-1",
    "exact",
    "Створи замовлення для Олени Петренко: 2 капучино і 1 круасан",
    "Олена Петренко",
    line("2", "Капучино"),
    line("1", "Круасан"),
  ),
  c(
    "exact-2",
    "exact",
    "Замовлення для Ігоря Шевчука: 3 лате",
    "Ігор Шевчук",
    line("3", "Лате"),
  ),
  c(
    "exact-3",
    "exact",
    "Оформи для ТОВ Ромашка 10 багетів",
    "ТОВ Ромашка",
    line("10", "Багет"),
  ),
  c(
    "exact-4",
    "exact",
    "Наталії Гук 2 тірамісу і 1 медовик",
    "Наталія Гук",
    line("2", "Тірамісу"),
    line("1", "Медовик"),
  ),
  c(
    "plural-1",
    "inflected",
    "Замовлення для Марії Коваль: 4 еклери фісташкові",
    "Марія Коваль",
    line("4", "Еклер фісташковий"),
  ),
  c(
    "plural-2",
    "inflected",
    "Для Оксани Бондар 5 булочок з корицею",
    "Оксана Бондар",
    line("5", "Булочка з корицею"),
  ),
  c(
    "plural-3",
    "inflected",
    "Віктору Гриценку 2 чізкейки нью-йорк",
    "Віктор Гриценко",
    line("2", "Чізкейк Нью-Йорк"),
  ),
  c(
    "plural-4",
    "inflected",
    "Наталії Гук 3 маффіни шоколадні",
    "Наталія Гук",
    line("3", "Маффін шоколадний"),
  ),
  c(
    "plural-5",
    "inflected",
    "Наталії Гук 3 сендвічі з лососем",
    "Наталія Гук",
    line("3", "Сендвіч з лососем"),
  ),
  c(
    "partial-1",
    "partial",
    "Для Олени Петренко 2 великих капучино",
    "Олена Петренко",
    line("2", "Капучино велике"),
  ),
  c(
    "partial-2",
    "partial",
    "Ігорю Шевчуку 1 лате на вівсяному молоці",
    "Ігор Шевчук",
    line("1", "Лате на вівсяному"),
  ),
  c(
    "partial-3",
    "partial",
    "Ірині Шевчук 1 матча лате холодне і 2 тістечка картопля",
    "Ірина Шевчук",
    line("1", "Матча лате холодне"),
    line("2", "Тістечко картопля"),
  ),
  c(
    "variant-1",
    "variant named",
    "Олені Петренко 6 макаронсів лимон",
    "Олена Петренко",
    line("6", "Макаронси", "Лимон"),
  ),
  c(
    "variant-2",
    "variant named",
    "Для Ігоря Шевчука 12 лимонних макаронсів",
    "Ігор Шевчук",
    line("12", "Макаронси", "Лимон"),
  ),
  c(
    "variant-3",
    "variant named",
    "Оксані Бондар 2 футболки з логотипом розмір M",
    "Оксана Бондар",
    line("2", "Футболка з логотипом", "M"),
  ),
  c(
    "variant-4",
    "variant named",
    "Марії Коваль 1 торт бісквітний полуничний",
    "Марія Коваль",
    line("1", "Торт бісквітний", "Полуничний"),
  ),
  c(
    "variant-5",
    "variant named",
    "Наталії Гук 3 макаронси фісташка і 3 макаронси малина",
    "Наталія Гук",
    line("3", "Макаронси", "Фісташка"),
    line("3", "Макаронси", "Малина"),
  ),
  c(
    "variant-6",
    "variant named",
    "Наталії Гук 2 чаї листові зелені",
    "Наталія Гук",
    line("2", "Чай листовий", "Зелений"),
  ),
  c(
    "variant-open-1",
    "variant not named",
    "Олені Петренко 6 макаронсів",
    "Олена Петренко",
    line("6", "Макаронси", RESOLVE_PICKER),
  ),
  c(
    "variant-open-2",
    "variant not named",
    "Ігорю Шевчуку 1 футболку з логотипом",
    "Ігор Шевчук",
    line("1", "Футболка з логотипом", RESOLVE_PICKER),
  ),
  c(
    "who-1",
    "customer not told apart",
    "Замовлення для Віктора: 2 американо",
    RESOLVE_PICKER,
    line("2", "Американо"),
  ),
  c(
    "who-2",
    "customer not told apart",
    "Для Коваль 1 лате",
    RESOLVE_PICKER,
    line("1", "Лате"),
  ),
  c(
    "who-3",
    "customer not told apart",
    "Для Олени 2 еспресо",
    RESOLVE_PICKER,
    line("2", "Еспресо"),
  ),
  c(
    "who-4",
    "customer not told apart",
    "Для Ромашки 5 круасанів",
    RESOLVE_PICKER,
    line("5", "Круасан"),
  ),
  c(
    "told-apart-1",
    "customer told apart by words",
    "Для Віктора Грищенка 2 какао",
    "Віктор Грищенко",
    line("2", "Какао"),
  ),
  c(
    "told-apart-2",
    "customer told apart by words",
    "Для Кава Хаус на Подолі 20 круасанів з шоколадом",
    "Кава Хаус Поділ",
    line("20", "Круасан з шоколадом"),
  ),
  c(
    "told-apart-3",
    "customer told apart by words",
    "Для Мельника з синами 4 багети житні",
    "ФОП Мельник і сини",
    line("4", "Багет житній"),
  ),
  c(
    "absent-1",
    "no such record",
    "Для Олени Петрашенко 2 лате",
    RESOLVE_NONE,
    line("2", "Лате"),
  ),
  c(
    "absent-2",
    "no such record",
    "Олені Петренко 2 піци маргарита",
    "Олена Петренко",
    line("2", RESOLVE_NONE),
  ),
  c(
    "typo-1",
    "typo",
    "Олені Птеренко 2 капучіно",
    "Олена Петренко",
    line("2", "Капучино"),
  ),
  c(
    "typo-2",
    "typo",
    "Ігорю Шевчуку 3 круасани з мігдалем",
    "Ігор Шевчук",
    line("3", "Круасан з мигдалем"),
  ),
  c(
    "short-1",
    "diminutive or transliteration",
    "Для Оленки Петренко 1 раф",
    "Олена Петренко",
    line("1", "Раф"),
  ),
  c(
    "short-2",
    "diminutive or transliteration",
    "For Anna Kowalska 2 flat white",
    "Anna Kowalska",
    line("2", "Флет вайт"),
  ),
  c(
    "many-1",
    "several lines",
    "Андрію Коваленку: 2 американо, 1 чізкейк класичний і 3 макаронси шоколад",
    "Андрій Коваленко",
    line("2", "Американо"),
    line("1", "Чізкейк класичний"),
    line("3", "Макаронси", "Шоколад"),
  ),
  c(
    "many-2",
    "several lines",
    "Для Coffee Point Lviv 15 брауні та 10 маффінів чорничних",
    "Coffee Point Lviv",
    line("15", "Брауні"),
    line("10", "Маффін чорничний"),
  ),
  c(
    "many-3",
    "several lines",
    "Марині Коваль 2 круасани з шинкою і 2 какао з сиропом",
    "Марина Коваль",
    line("2", "Круасан з шинкою"),
    line("2", "Какао з сиропом"),
  ),
];
