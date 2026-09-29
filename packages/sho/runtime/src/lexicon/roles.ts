// Cue words that give a span its param when an intent has several params of one type (intents v3 §6b, D69). The model tags types; the words next to a
// span say its role. Stems match the start of a word outside every tagged span; uk and ru.

// A cue: the stems that say it, how many words before and after the span it reaches, and whether it needs another span of the same type to take the
// default param (`split`: «500 готівкою» is a part of a mixed payment only when a total is said too).
export interface Cue {
  readonly stems: readonly string[];
  readonly words?: readonly string[];
  readonly before: number;
  readonly after: number;
  readonly withOther?: true;
  // D82: two words in a row that cue together, the first whole and the second by its stem («після оплати»: neither alone says cash on delivery).
  readonly pairs?: readonly (readonly [first: string, second: string])[];
}

// Cues by param name, for the params that share a type with another param of their intent.
export const PARAM_CUES: Readonly<Record<string, Cue>> = {
  // `delivery.*`: cash on delivery («накладений платіж», «наложка», «післяплата», «контроль оплати») vs the declared value («оголошена / оціночна
  // вартість», «оцінка», «страховка»).
  cod: { stems: ["наклад", "налож", "післяплат", "послеоплат", "післяоплат", "контрол", "отриман", "получен", "наложк"], before: 4, after: 1, pairs: [["після", "оплат"], ["после", "оплат"]] },
  declared: { stems: ["оголош", "оцін", "оцен", "объявл", "обявл", "страх", "вартіст", "стоимост", "цінніст", "ценност"], before: 4, after: 1 },
  // A discount: «знижка 10 відсотків», «мінус 200», «скидка 5%».
  discount: { stems: ["знижк", "знижц", "скидк", "скидоч", "мінус", "минус"], before: 3, after: 1 },
  // A part of a mixed payment: a money span said with a payment method word right after it («500 готівкою, решта карткою»).
  split: { stems: ["готівк", "налич", "кеш", "карт", "безнал", "терміна", "терминал", "переказ", "перевод"], before: 0, after: 1, withOther: true },
};

// «решта карткою», «остальное картой»: the rest of a mixed payment, so a money span with a method word is a part even when no total is said.
export const REST_STEMS: readonly string[] = ["решт", "остальн", "остат", "інше", "другу част"];

// «контроль оплати» makes cash on delivery NovaPay's payment control, not the classic «накладений платіж» (intents v3 §4.2).
export const PAYMENT_CONTROL_STEMS: readonly string[] = ["контрол"];

// `orders.update` (intents v3 §6b): the verb before an order line says whether it is added, removed or changed. Stems match a word's start; `words`
// match a whole word.
export type LineRole = "add" | "remove" | "set";
export const LINE_CUES: Readonly<Record<LineRole, { readonly stems: readonly string[]; readonly words: readonly string[] }>> = {
  add: { stems: ["дода", "допис", "допиш", "добав", "докин", "докла", "докуп", "довез"], words: ["ще", "еще", "ещё", "плюс"] },
  remove: { stems: ["прибер", "прибра", "прибир", "убер", "убра", "убир", "видал", "удал", "викресл", "вычеркн", "викин", "выкин", "знім", "сним", "сніми", "вилуч", "виключ", "исключ", "забер"], words: ["без"] },
  set: { stems: ["змін", "змен", "замін", "замен", "помін", "помен", "измен", "постав", "зроб", "сдела", "испр", "випр", "кільк", "колич", "замість", "вместо"], words: [] },
};

// Words that name the attribute a change is about («зміни колір худі з сірого на чорний», «поменяй размер … с 42 на 43»): then «з X на Y» changes the
// line's attr (a set line); without one it is a swap of two lines («заміни стрижку з середнього на довге»). D82: «варіант» names one too («поменяй
// вариант капкейков с ванильного на шоколадный»).
export const ATTRIBUTE_WORDS: readonly string[] = ["колір", "кольор", "цвет", "розмір", "размер", "об'єм", "объем", "вага", "вес", "смак", "вкус", "варіант", "вариант"];

// D73: words that say the line changes to another version of its product («заміни айфон на версію на 256»): with the «на» before them they are no part of
// the product's name.
export const VERSION_WORDS: ReadonlySet<string> = new Set(["версію", "версія", "версії", "версию", "версия", "версии", "варіант", "варіанта", "вариант", "варианта", "модифікацію", "модификацию", "комплектацію", "комплектацию"]);

// In a change, «на» parts the old from the new («чорну сукню на червону», «кількість цементу на 15»), «замість» / «вместо» puts the old after it («замість
// двох фарб зроби три»), and «з» / «с» before a value says it is the old one («розмір з 42 на 43»).
export const NEW_AFTER: ReadonlySet<string> = new Set(["на"]);
export const OLD_AFTER: ReadonlySet<string> = new Set(["замість", "вместо"]);
export const OLD_BEFORE: ReadonlySet<string> = new Set(["з", "с", "із", "зі", "от", "из", "со"]);
// «не білі а рожеві», «на чотири а не на два»: after «не», up to «а», is the old value.
export const NOT_WORDS: ReadonlySet<string> = new Set(["не"]);
export const BUT_WORDS: ReadonlySet<string> = new Set(["а"]);

// D70: params an uncued span never fills by default. Cash on delivery and the declared value of a shipment are both money; a sum said with no cue
// word («відправ … на 1500») could be either, and a wrong cash on delivery makes the recipient pay, so the card asks («накладений платіж чи оголошена
// вартість?») instead of guessing. Each group is the params the card offers, in the intent's order.
export const ASKED_ROLES: readonly (readonly string[])[] = [["cod", "declared"]];

// D70: the payment method a word after a part of a mixed payment names («500 готівкою», «решта карткою»), by the start of the word.
export type PaymentMethodKey = "cash" | "card" | "cashless";
export const METHOD_STEMS: readonly (readonly [stem: string, method: PaymentMethodKey])[] = [
  ["готівк", "cash"], ["налич", "cash"], ["наліч", "cash"], ["кеш", "cash"], ["кэш", "cash"],
  ["картк", "card"], ["карточк", "card"], ["карт", "card"], ["терміна", "card"], ["терминал", "card"],
  ["безнал", "cashless"], ["переказ", "cashless"], ["перевод", "cashless"], ["рахун", "cashless"], ["счет", "cashless"], ["айбан", "cashless"], ["iban", "cashless"],
];

// D86 (F5): the words that name a discount right before its number («зі знижкою 8%», «со скидкой 5 процентов», «з дисконтом 10%»): the start of a word.
export const DISCOUNT_STEMS: readonly string[] = ["знижк", "знижц", "скидк", "скидоч", "дисконт"];
