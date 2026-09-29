export const CUSTOMER_LEADS: ReadonlySet<string> = new Set(["для", "клієнту", "клієнта", "клієнтові", "клиенту", "клиента", "від", "от"]);
// «й» since D66: «Юрій» is «юрию» in Russian, its «й» an ending as «я» in «Юрія».
// D72: the masculine instrumental and dative endings too, for a short last part of a hyphenated name («мебель-югом» «Мебель-Юг», «юга», «югові»).
export const NAME_ENDINGS: readonly string[] = ["а", "я", "у", "ю", "і", "и", "ї", "о", "е", "є", "ою", "ею", "єю", "ої", "ей", "й", "ом", "ем", "єм", "ові", "еві", "єві"];
// «ё» folds to «е» since D71 («Алёна» «Алена»).
export const NAME_FOLDS: ReadonlyMap<string, string> = new Map([["і", "и"], ["ї", "и"], ["ы", "и"], ["є", "е"], ["э", "е"], ["ё", "е"]]);
// Stems of the words that name the customer record itself («клієнта», «покупців», «контакт», ru «клиента»): a customer action said with one means a customer,
// even when the name speaks of a product («картка клієнта вареничка», D64).
export const CUSTOMER_WORD_STEMS: readonly string[] = ["клієнт", "кліент", "клиент", "покупц", "покупец", "покупател", "контакт", "замовник", "заказчик"];
// Legal forms that stand before a customer's name («ФОП Гуменюк Василина», «ТОВ «Ромашка»»): a spoken word matches one only as such, and a name said
// without it is still that customer (D71). Lowercase, as `nameWords` gives them.
export const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "фоп", "флп", "фо-п", "спд", "тов", "тзов", "пп", "прат", "пат", "ат", "дп", "кп", "кнп", "фг", "сфг", "го", "бф", "осбб", "ооо", "чп", "ип", "чао", "оао", "зао",
]);
// Nouns that say what kind of place a customer is, said before its name when the name does not hold them («для клубу «Десна»», «кав'ярні лате»,
// ru «кафе ромашка»): the words after one name the customer (D71). A word the name holds is matched as the name's own («Клуб коропарів «Десна»»).
export const PLACE_NOUNS: readonly string[] = [
  "клуб", "кафе", "кав'ярня", "кофейня", "ресторан", "магазин", "салон", "студія", "студия", "школа", "ліцей", "лицей", "гімназія", "гимназия", "садок",
  "садочок", "садик", "готель", "гостиница", "отель", "бар", "піцерія", "пиццерия", "пекарня", "компанія", "компания", "фірма", "фирма", "агенція",
  "агентство", "бюро", "фабрика", "завод", "ательє", "ателье", "майстерня", "мастерская", "ферма", "центр", "хор", "ансамбль", "театр", "бригада",
  "аптека", "лікарня", "больница", "клініка", "клиника", "ресторація", "їдальня", "столовая", "офіс", "офис",
];
// D84: the words that address an existing customer in the dative right before the name («додай клієнту Євген Панасюк коментар …», ru «добавь клиентке …»):
// with them, a `customers.createCustomer` for a name the list knows whole is that customer's update (`createAsUpdate.ts`).
export const DATIVE_CUSTOMER_LEADS: ReadonlySet<string> = new Set(["клієнту", "клієнтові", "клієнтці", "клиенту", "клиентке"]);
// D84: the verbs a customer's name said in the dative follows («додай шерлоку коментар …»), the first word of the command.
export const DATIVE_ADD_VERBS: ReadonlySet<string> = new Set(["додай", "додайте", "додати", "добав", "добавь", "добавьте", "добавить"]);
// D84: the masculine dative endings a name said after one of `DATIVE_ADD_VERBS` may take: «-ові / -еві» of any name, «-у / -ю» of a name that ends in a
// consonant, «й», «ь» or «о» («олегу», «андрію», «василю», «петру»); a feminine «-у / -ю» is the accusative («марію»), «-і» also the genitive.
export const DATIVE_NAME_ENDINGS: readonly string[] = ["ові", "еві", "єві"];
export const DATIVE_SHORT_ENDINGS: readonly string[] = ["у", "ю"];
// D84: words that say the customer is new («додай нового клієнта», «новому клієнту»): a create with one before the name stays a create.
export const NEW_WORDS: ReadonlySet<string> = new Set([
  "новий", "нового", "новому", "новим", "нову", "нова", "нової", "новій", "новою", "новый", "новую", "новая", "новой", "новым",
]);
// D85: the verbs that rename a record («перейменуй групу … на …», «надю переименуй надежда кравец»), uk and ru, with the recogniser's «переіменуй»: a
// second customer span after one is the customer's new name (`command.ts` `renamedCustomer`); a group edit that says one is about the group
// (`createAsUpdate.ts` `groupAsUpdate` keeps it).
export const RENAME_VERBS: ReadonlySet<string> = new Set([
  "перейменуй", "перейменуйте", "перейменувати", "переіменуй", "переіменуйте", "переіменувати", "переименуй", "переименуйте", "переименовать",
  "переназви", "переназвіть", "переназвати", "переназови", "переназовите", "переназвать",
]);
// D85: the words between a rename verb and the new name («переименуй надю в надежду», «перейменуй на …»).
export const RENAME_LEADS: ReadonlySet<string> = new Set(["на", "в", "у", "во"]);
