// D94 (`contacts.ts` `createAsFind`): the words that say a customer is looked for, and the words that say one is made. Lowercase word forms, uk / ru /
// surzhyk, as `normalise` writes them.

// The customer noun a contact is said with in the dative («замовлення клієнту з номером …»): `DEICTICS` reads it as a pointer at the host's record,
// which a contact said right for the customer takes the place of (`contacts.ts` `saidContacts`).
export const BARE_CUSTOMER_WORDS: ReadonlySet<string> = new Set(["клієнту", "клієнтці", "клиенту", "клиентке"]);

// A find or search verb, matched whole («знайди клієнта з номером …», «пошукай …», ru «найди», «поищи»): «найда» (a surname) is none.
export const FIND_WORDS: ReadonlySet<string> = new Set([
  "знайди", "знайдіть", "знайти", "знайдеш", "найди", "найдите", "найти", "найдешь", "пошукай", "пошукайте", "пошукати", "шукай", "шукайте", "шукати",
  "відшукай", "відшукайте", "розшукай", "розшукайте", "поищи", "поищите", "поискать", "ищи", "ищите", "искать", "отыщи", "разыщи", "пошук", "поиск",
]);

// A question whose answer is the customer: «чий це номер …», «чия це пошта …», ru «чей это номер»; and «хто це» / «кто это» (`FIND_PHRASES`).
export const WHOSE_WORDS: ReadonlySet<string> = new Set(["чий", "чия", "чиє", "чиї", "чей", "чья", "чьё", "чье", "чьи"]);
export const FIND_PHRASES: readonly (readonly [string, string])[] = [["хто", "це"], ["хто", "то"], ["хто", "такий"], ["хто", "така"], ["кто", "это"], ["кто", "такой"], ["кто", "такая"]];

// A verb that makes or saves a record, by the start of the word («додай», «створи», «заведи», «запиши», «внеси», «збережи», «зареєструй», «закинь»,
// ru «добавь», «создай», «сохрани», «зарегистрируй»): with one, a create stays a create.
export const CREATE_STEMS: readonly string[] = [
  "дода", "добав", "створ", "созда", "завед", "завес", "запиш", "запис", "внес", "внос", "занес", "збереж", "зберег", "сохран", "зареєстр", "зарегистр",
  "закин", "оформ", "вбий", "вбей", "забий", "забей",
];
