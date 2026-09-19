const FIRST_NAMES = [
  "Олена",
  "Олег",
  "Олеся",
  "Ольга",
  "Олександр",
  "Олександра",
  "Ігор",
  "Ірина",
  "Марія",
  "Марина",
  "Андрій",
  "Анна",
  "Ганна",
  "Антон",
  "Петро",
  "Віктор",
  "Вікторія",
  "Наталія",
  "Оксана",
  "Дмитро",
  "Сергій",
  "Василь",
  "Юлія",
  "Тетяна",
] as const;

const SURNAMES = [
  "Петренко",
  "Петрук",
  "Петрів",
  "Коваленко",
  "Коваль",
  "Ковальчук",
  "Шевчук",
  "Шевченко",
  "Шевчишин",
  "Бондар",
  "Бондарчук",
  "Мельник",
  "Мельниченко",
  "Гриценко",
  "Грищенко",
  "Лисенко",
  "Лисак",
  "Ткач",
  "Ткаченко",
  "Ткачук",
  "Мороз",
  "Морозенко",
  "Савченко",
  "Савчук",
  "Кравченко",
  "Кравчук",
  "Кравець",
  "Олійник",
  "Поліщук",
  "Руденко",
  "Марченко",
  "Левченко",
  "Гук",
  "Гуменюк",
  "Сидоренко",
  "Захарченко",
  "Романенко",
  "Романюк",
  "Яковенко",
  "Яременко",
] as const;

const BUSINESSES = [
  "ТОВ Ромашка",
  "ТОВ Ромашка Плюс",
  "ФОП Ромашко О.В.",
  "ФОП Мельник",
  "ФОП Мельник і сини",
  "Кава Хаус",
  "Кава Хаус Поділ",
  "Кав'ярня На розі",
  "Кав'ярня На розі 2",
  "ТОВ Смачна Хата",
  "Пекарня Хлібна Хата",
  "Ресторан Веранда",
  "Готель Дністер",
  "ТОВ Дністер Трейд",
  "Anna Kowalska",
  "Coffee Point",
  "Coffee Point Lviv",
  "Олександр Білий",
  "Олександра Біла",
  "Сашко Чорний",
] as const;

const TARGET_PEOPLE = [
  "Олена Петренко",
  "Ігор Шевчук",
  "Марія Коваль",
  "Оксана Бондар",
  "Наталія Гук",
  "Ольга Мороз",
  "Віктор Гриценко",
  "Віктор Грищенко",
  "Андрій Коваленко",
  "Ольга Коваленко",
  "Олена Петрук",
  "Олег Петренко",
  "Марина Коваль",
  "Марія Ковальчук",
  "Ігор Шевченко",
  "Ірина Шевчук",
] as const;

export const SEED_CUSTOMER_COUNT = 300;

export function seedCustomerNames(): readonly string[] {
  const names = new Set<string>([...BUSINESSES, ...TARGET_PEOPLE]);
  for (let i = 0; names.size < SEED_CUSTOMER_COUNT; i += 1) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length] ?? "";
    const surname =
      SURNAMES[
        (i * 7 + Math.floor(i / FIRST_NAMES.length)) % SURNAMES.length
      ] ?? "";
    names.add(`${first} ${surname}`);
  }
  return [...names];
}

export const SEED_GROUP_NAMES = [
  "Оптовики",
  "Роздріб",
  "VIP",
  "Постійні клієнти",
  "Нові клієнти",
  "Кав'ярні",
  "Ресторани",
  "Готелі",
  "Хорека",
  "Корпоративні",
  "Співробітники",
  "Оптовики Захід",
] as const;

const DRINKS = [
  "Капучино",
  "Лате",
  "Американо",
  "Еспресо",
  "Флет вайт",
  "Раф",
  "Какао",
  "Матча лате",
  "Мокачино",
  "Макіато",
  "Чай чорний",
  "Чай зелений",
] as const;
const DRINK_VARIANTS = [
  "",
  "велике",
  "мале",
  "на вівсяному",
  "безкофеїнове",
  "з сиропом",
  "холодне",
] as const;
const BAKERY = [
  "Круасан",
  "Круасан з шоколадом",
  "Круасан з мигдалем",
  "Круасан з шинкою",
  "Чізкейк класичний",
  "Чізкейк шоколадний",
  "Чізкейк Нью-Йорк",
  "Еклер",
  "Еклер ванільний",
  "Еклер фісташковий",
  "Макарон",
  "Макарон малиновий",
  "Тістечко картопля",
  "Тірамісу",
  "Багет",
  "Багет житній",
  "Булочка з корицею",
  "Булочка з маком",
  "Рафаелло",
  "Раф лавандовий",
  "Наполеон",
  "Медовик",
  "Брауні",
  "Маффін шоколадний",
  "Маффін чорничний",
  "Печиво вівсяне",
  "Сендвіч з куркою",
  "Сендвіч з лососем",
  "Салат Цезар",
  "Гранола",
] as const;
const BEANS = [
  "Бразилія",
  "Колумбія",
  "Ефіопія",
  "Кенія",
  "Гватемала",
] as const;
const PACKS = ["250 г", "1 кг"] as const;
const BEAN_FORMS = ["в зернах", "мелена"] as const;

export function seedProductNames(): readonly string[] {
  const names = new Set<string>(BAKERY);
  for (const drink of DRINKS) {
    for (const variant of DRINK_VARIANTS) {
      names.add(variant === "" ? drink : `${drink} ${variant}`);
    }
  }
  for (const origin of BEANS) {
    for (const form of BEAN_FORMS) {
      for (const pack of PACKS) {
        names.add(`Кава ${form} ${origin} ${pack}`);
      }
    }
  }
  return [...names];
}

export const BASE_AMBIGUOUS = "ambiguous";
export const BASE_NONE = "none";

export type BaseKind = "customer" | "product" | "customer group";

export interface BaseMention {
  readonly id: string;
  readonly kind: BaseKind;
  readonly mention: string;
  readonly expected: readonly string[];
}

const m = (
  kind: BaseKind,
  id: string,
  mention: string,
  ...expected: string[]
): BaseMention => ({ id, kind, mention, expected });

export const BASE_MENTIONS: readonly BaseMention[] = [
  m("customer", "genitive-full-name", "олени петренко", "Олена Петренко"),
  m("customer", "accusative-full-name", "ігоря шевчука", "Ігор Шевчук"),
  m("customer", "accusative-female", "марію коваль", "Марія Коваль"),
  m("customer", "dative-full-name", "оксані бондар", "Оксана Бондар"),
  m("customer", "surname-first", "шевчук ігор", "Ігор Шевчук"),
  m("customer", "nominative", "Наталія Гук", "Наталія Гук"),
  m("customer", "surname-only-many", "коваленка", BASE_AMBIGUOUS),
  m("customer", "first-name-only-many", "олену", BASE_AMBIGUOUS),
  m("customer", "diminutive-with-surname", "саша білий", "Олександр Білий"),
  m("customer", "diminutive-female", "олі мороз", "Ольга Мороз"),
  m("customer", "company-exact", "тов ромашка", "ТОВ Ромашка"),
  m("customer", "company-bare", "ромашка плюс", "ТОВ Ромашка Плюс"),
  m("customer", "company-two-branches", "кава хаус", "Кава Хаус"),
  m("customer", "company-branch", "кава хаус на подолі", "Кава Хаус Поділ"),
  m("customer", "sole-proprietor", "фоп мельник", "ФОП Мельник"),
  m("customer", "latin-name", "anna kowalska", "Anna Kowalska"),
  m("customer", "transliterated", "анна ковальська", "Anna Kowalska"),
  m("customer", "latin-business", "кофі поінт львів", "Coffee Point Lviv"),
  m("customer", "near-surname", "віктора гриценка", "Віктор Гриценко"),
  m("customer", "misspelled", "олена питренко", "Олена Петренко"),
  m("customer", "no-record", "тараса шевельова", BASE_NONE),
  m("customer", "no-record-near", "олена петрашенко", BASE_NONE),
  m("product", "exact-beats-variants", "капучино", "Капучино"),
  m(
    "product",
    "variant-named",
    "капучино на вівсяному",
    "Капучино на вівсяному",
  ),
  m("product", "plural-genitive", "круасанів", "Круасан"),
  m(
    "product",
    "plural-with-filling",
    "круасани з шоколадом",
    "Круасан з шоколадом",
  ),
  m("product", "two-variants", "чізкейків", BASE_AMBIGUOUS),
  m("product", "variant-by-city", "чізкейк нью йорк", "Чізкейк Нью-Йорк"),
  m("product", "misspelled", "капучіно", "Капучино"),
  m("product", "latin-for-cyrillic", "flat white", "Флет вайт"),
  m("product", "plural-short", "рафи", "Раф"),
  m("product", "diminutive", "тістечко", "Тістечко картопля"),
  m("product", "generic-word", "кави", BASE_AMBIGUOUS),
  m(
    "product",
    "beans-specific",
    "кіло ефіопії в зернах",
    "Кава в зернах Ефіопія 1 кг",
  ),
  m("product", "size-colloquial", "великий лате", "Лате велике"),
  m("product", "no-record", "піца маргарита", BASE_NONE),
  m("product", "eclair-flavour", "фісташкових еклерів", "Еклер фісташковий"),
  m(
    "customer group",
    "genitive-plural",
    "оптовиків",
    BASE_AMBIGUOUS,
    "Оптовики",
  ),
  m("customer group", "cyrillic-for-latin", "віп", "VIP"),
  m("customer group", "shortened", "постійні", "Постійні клієнти"),
  m("customer group", "locative", "в ресторанах", "Ресторани"),
  m("customer group", "no-record", "блогери", BASE_NONE),
];
