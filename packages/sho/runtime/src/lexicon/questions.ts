// D97 (`howTo.ts`): the words of a question about the app itself — how to do something in it, what something is, where something is in it. Lowercase
// word forms, uk / ru / surzhyk, as `normalise` writes them; a word is matched whole. The lists come from the gold sets: the 28 rows they open in
// `test_verified` (8), the dictation v5 gold (6), Shozee's SHO-740 (8) and the v2 `grammar_test` (6) are all gold `none`, and no row of any gold or
// evaluation set that they open is a command; «де» alone opens gold commands (a parcel or a record asked where), so a where-question needs the app
// said (docs/decisions.md D97).

// Words said before the question («підкажи, а як мені …», «слухай, где в этом приложении …», «не розумію, як це налаштувати»): skipped at the start.
export const QUESTION_FILLERS: ReadonlySet<string> = new Set([
  "а", "і", "и", "й", "ну", "так", "ой", "слухай", "слухайте", "слушай", "слушайте", "скажи", "скажіть", "скажите", "підкажи", "підкажіть",
  "подскажи", "подскажите", "порадь", "порадьте", "посоветуй", "посоветуйте", "поясни", "поясніть", "объясни", "объясните", "будь", "ласка",
  "пожалуйста", "привіт", "привет", "добрий", "доброго", "день", "дня", "здравствуйте", "вибач", "вибачте", "извини", "извините", "я", "не", "розумію",
  "зрозумів", "зрозуміла", "знаю", "понимаю", "понял", "поняла",
]);
export const QUESTION_FILLERS_MAX = 5;

// «як», «как»: a how-question when the next word is one of `HOW_CUES` («як мені», «как тут»), when «(це) працює» follows («як воно працює з передоплатою»), or
// when an infinitive stands within `HOW_REACH` words («як додати знижку», «как в этом разделе выгрузить отчёт», «як для <ім'я> виставити рахунок»).
export const HOW_WORDS_UK: ReadonlySet<string> = new Set(["як"]);
export const HOW_WORDS_RU: ReadonlySet<string> = new Set(["как"]);
export const HOW_CUES: ReadonlySet<string> = new Set(["мені", "мне", "нам", "тут", "здесь"]);
export const HOW_SUBJECTS: ReadonlySet<string> = new Set(["це", "воно", "вона", "він", "это", "оно", "она", "он"]);
export const HOW_WORKS: ReadonlySet<string> = new Set(["працює", "працюють", "работает", "работают"]);
export const HOW_REACH = 4;

// The word right after «як / как» that makes it no question about the app: «як завжди», «як тільки прийде оплата …», «як і минулого разу», «як можна
// швидше відправ …» (with `COMPARATIVES`), «як справи», «як щодо …», «як ти думаєш».
export const HOW_NOT_NEXT: ReadonlySet<string> = new Set([
  "тільки", "только", "лише", "лиш", "завжди", "всегда", "зазвичай", "обычно", "і", "и", "й", "та", "раніше", "раньше", "минулого", "минулий",
  "минулому", "прошлого", "прошлый", "прошлом", "вчора", "вчера", "домовлялись", "домовлялися", "домовились", "домовилися", "договаривались",
  "договорились", "справи", "дела", "щодо", "насчет", "насчёт", "там", "ти", "ты", "ви", "вы", "ж", "же",
  ...["швидше", "скоріше", "найшвидше", "якнайшвидше", "быстрее", "скорее", "побыстрее", "поскорее"],
]);
export const MAY_WORDS: ReadonlySet<string> = new Set(["можна", "можно"]);
export const COMPARATIVES: ReadonlySet<string> = new Set([
  "швидше", "скоріше", "раніше", "більше", "менше", "дешевше", "быстрее", "скорее", "раньше", "больше", "меньше", "дешевле",
]);
// A clause ends here: an infinitive after it is another clause's.
export const HOW_CLAUSE_ENDS: ReadonlySet<string> = new Set(["і", "и", "й", "та", "а", "але", "но", "або", "или"]);

// An infinitive, by its ending: uk «-ти / -тися / -тись» after a vowel, «й», «с», «з» («додати», «знайти», «вести», «везти», «змінитися»); ru «-ть /
// -ться» after a vowel, «-чь», and «-йти / -дти / -сти / -зти» («поменять», «найти», «идти», «нести»). Nouns and numerals with those endings are
// `NOT_INFINITIVES` («звіти», «путь», «десять»); a word with a digit is none.
export const INFINITIVE_UK = /(?:[аяиіуї]ти|[аяиіуї]тися|[аяиіуї]тись|йти|йтися|йтись|сти|стися|зти)$/u;
export const INFINITIVE_RU = /(?:[аяеиоуыё]ть|[аяеиоуыё]ться|чь|чься|йти|дти|сти|зти)$/u;
export const INFINITIVE_MIN = 5;
export const NOT_INFINITIVES: ReadonlySet<string> = new Set([
  "звіти", "оплати", "кредити", "депозити", "квіти", "діти", "суті",
  "путь", "суть", "мать", "сеть", "печать", "кровать", "пять", "девять", "десять", "шесть",
]);
export const NUMERAL_ENDINGS: readonly string[] = ["дцять", "дцать", "десять", "десят"];

// «що таке», «що це таке», «що означає», «что такое», «что значит»: what something is.
export const WHAT_WORDS: ReadonlySet<string> = new Set(["що", "шо", "что", "чо"]);
export const WHAT_THIS: ReadonlySet<string> = new Set(["це", "это"]);
export const WHAT_CUES: ReadonlySet<string> = new Set(["таке", "такое", "означає", "значить", "значит", "означает"]);

// «де / где» with the app said after a preposition («де в застосунку …», «где в этом приложении …», «де у вашій програмі …») or a button («де ця
// кнопка»). A bare «де» is a record's question («де замовлення Олі», «де моя посилка», «де прайси»: what the gold reads as navigation, find or
// tracking), and so is «де в меню …» or «де в системі …» (a menu is a café's).
export const WHERE_WORDS: ReadonlySet<string> = new Set(["де", "где"]);
export const WHERE_PREPOSITIONS: ReadonlySet<string> = new Set(["в", "у", "во"]);
export const WHERE_DETERMINERS: ReadonlySet<string> = new Set([
  "цьому", "цій", "вашому", "вашій", "нашому", "нашій", "тому", "тій", "этом", "этой", "вашем", "вашей", "нашем", "нашей", "том", "той",
]);
export const APP_WORDS: ReadonlySet<string> = new Set([
  "застосунок", "застосунку", "застосунка", "застосунці", "додаток", "додатку", "додатка", "програма", "програмі", "програму", "програми", "апка",
  "апці", "апку", "апки", "аплікації", "аплікація", "налаштуваннях", "налаштування", "інтерфейсі", "приложение", "приложении", "приложения",
  "программа", "программе", "программу", "программы", "настройках", "настройки", "интерфейсе",
]);
export const BUTTON_DETERMINERS: ReadonlySet<string> = new Set(["ця", "та", "эта", "цю", "эту"]);
export const BUTTON_WORDS: ReadonlySet<string> = new Set(["кнопка", "кнопку", "кнопочка"]);
