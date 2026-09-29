export const CONNECTORS: ReadonlySet<string> = new Set(["і", "та", "ще", "плюс", "потім", "далі", "й", "и", "еще", "ещё", "также", "потом", "дальше", "а", "також", "туди", "туда", "додай", "додайте", "додамо", "добав", "добавь", "добавьте", "добавим", "давай", "давайте", "візьми", "візьміть", "запиши", "запишіть", "постав", "поставте", "дай", "дайте", "хочу", "хочемо", "возьми", "возьмите", "запишите", "поставь", "поставьте", "хотим", "нам", "мені", "мне", "ну", "так"]);
// «по» is «each» or «at» («по 50 мл», «по парі»): a gap like «на» (D64).
export const PREPOSITIONS: ReadonlySet<string> = new Set(["з", "із", "зі", "с", "со", "без", "на", "по"]);
export const WITH: ReadonlySet<string> = new Set(["з", "із", "зі", "с", "со"]);
export const LINE_WITH: ReadonlySet<string> = new Set([...WITH, "за"]);
export const WITHOUT: ReadonlySet<string> = new Set(["без"]);
export const ADJECTIVE_ENDINGS: readonly string[] = ["ий", "ій", "их", "ых", "ого", "ої", "ові", "ова", "ева", "ний", "ній"];
export const COUNTED_ENDINGS: readonly string[] = ["и", "ы", "ів", "ов", "ей", "ек", "ок"];
export const HALF = "пів";
// Words that name what the value after or before them is, never an item or a value (D64): «42 розмір», «розмір M», «колір чорний», «р.» (normalised «р»).
// The catalogue pass reads them as gaps; the model's spans lose them at their edges (`repair.ts` `spanEdges`).
export const LABEL_WORDS: ReadonlySet<string> = new Set(["розмір", "розміру", "розміри", "розмірів", "розмірі", "размер", "размера", "размеры", "размеров", "размере", "р", "size", "колір", "кольору", "кольори", "цвет", "цвета", "color", "colour"]);
// Colour words that count colours after a number: «24 кольори» is a set of 24 colours, a value, not the label «кольори» (D66).
export const COLOUR_COUNTS: ReadonlySet<string> = new Set(["кольори", "кольорів", "цвета", "цветов"]);
// «покажи всі сукні»: a word that asks for every record a name speaks of, a list and not one record (D64).
export const LIST_WORDS: ReadonlySet<string> = new Set(["всі", "усі", "все", "всё"]);
// Words that say which list a record belongs to, around its name («в групу оптові», «в оптовому прайсі», «прайс-лист кав'ярні»): no part of the name (D65).
export const LIST_LABELS: ReadonlySet<string> = new Set(["група", "групу", "групи", "групі", "групою", "группа", "группу", "группы", "группе", "прайс", "прайсі", "прайсу", "прайса", "прайсом", "прайсе", "лист", "листі", "листа", "листе", "прайслист", "контрагент", "контрагента", "контрагенту", "контрагентом"]);
// D86 (F5): plural adjective endings («фісташкові», «шоколадні», ru «ореховые», «сливочные»), beside `ADJECTIVE_ENDINGS`, for a product span said
// right before a discount that is the line's attr.
export const PLURAL_ADJECTIVE_ENDINGS: readonly string[] = ["ові", "еві", "ні", "ті", "кі", "ые", "ие"];
