// Words of a `when` span (intents v3 §5.1, D66): days, weekdays, parts of the day, bounds and the words around them, uk and ru.

export const RELATIVE_DAYS: ReadonlyMap<string, number> = new Map([
  ["сьогодні", 0],
  ["сегодня", 0],
  ["завтра", 1],
  ["післязавтра", 2],
  ["послезавтра", 2],
  ["вчора", -1],
  ["учора", -1],
  ["вчера", -1],
  ["позавчора", -2],
  ["позавчера", -2],
  // D71: the colloquial «сьодня» («сьодня ввечері»), ru «седня», «сёдня».
  ["сьодня", 0],
  ["сьогодня", 0],
  ["седня", 0],
  ["сёдня", 0],
]);

// «щас», «зараз», «сейчас»: now, today at the clock's time (D71).
export const NOW_WORDS: ReadonlySet<string> = new Set(["щас", "зараз", "сейчас", "счас", "сщас"]);

// The weekend (D71): «на вихідні», «на вихідних», ru «на выходных» are Saturday to Sunday (this weekend's on a Saturday, the next on a Sunday);
// «до вихідних», «к выходным» are by the Friday before it.
export const WEEKEND_WORDS: ReadonlySet<string> = new Set(["вихідні", "вихідних", "вихідним", "вихідними", "выходные", "выходных", "выходным", "выходными", "уікенд", "уикенд", "викенд"]);

// A month said alone in the dative («к ноябрю», «до листопаду»), with the forms `DATES` knows («до квітня», «в ноябре»): the month's first day or its
// days (D71).
export const MONTH_DATIVES: ReadonlyMap<string, number> = new Map(
  (
    [
      ["січню январю", 1], ["лютому февралю", 2], ["березню марту", 3], ["квітню апрелю", 4], ["травню маю", 5], ["червню июню", 6], ["липню июлю", 7],
      ["серпню августу", 8], ["вересню сентябрю", 9], ["жовтню октябрю", 10], ["листопаду ноябрю", 11], ["грудню декабрю", 12],
    ] as const
  ).flatMap(([forms, month]) => forms.split(" ").map((form) => [form, month] as const)),
);

// «за два тижні», «за три дні»: within that time, by its end (D71); «через» is the same point without the bound.
export const WITHIN = "за";

// «після роботи», «после работы»: after work, the evening a shop means (D71). Only after «після» / «после»: «до роботи» is no evening.
export const AFTER_WORK: ReadonlySet<string> = new Set(["роботи", "работы", "праці"]);
export const AFTER_WORK_TIME = "18:00";

// Weekday stems, Monday first.
export const WEEKDAY_STEMS: readonly (readonly string[])[] = [
  ["понеділ", "понедельн"],
  ["вівтор", "вторник"],
  ["серед", "сред"],
  ["четвер"],
  ["п'ятниц", "пятниц"],
  ["субот", "суббот"],
  ["неділ", "воскресен"],
];

// «щоп'ятниці», «кожної п'ятниці», «каждую пятницу», «по п'ятницях»: a weekday again and again. A recurrence has no `when` value yet (D66): the reader
// returns none, and the host asks.
export const RECURRING: readonly string[] = ["що", "кожн", "каждый", "каждую", "каждое", "каждой", "каждый"];

export type Bound = "at" | "by" | "after";

// A bound said before a time or a day: «до шостої», «к вечеру», «після обіду».
export const BOUNDS: ReadonlyMap<string, Bound> = new Map([
  ["до", "by"],
  ["к", "by"],
  ["по", "by"],
  ["після", "after"],
  ["после", "after"],
  // D71: ru «ко вторнику».
  ["ко", "by"],
]);

// Parts of the day, as a clock time: the morning, lunch and the evening a shop means.
export const PARTS_OF_DAY: ReadonlyMap<string, string> = new Map([
  ["зранку", "09:00"],
  ["вранці", "09:00"],
  ["ранку", "09:00"],
  ["утром", "09:00"],
  ["утра", "09:00"],
  ["обід", "13:00"],
  ["обіду", "13:00"],
  ["обед", "13:00"],
  ["обеда", "13:00"],
  ["обеду", "13:00"],
  // D71: «на завтра на ранок», ru «на утро».
  ["ранок", "09:00"],
  ["утро", "09:00"],
  ["ввечері", "18:00"],
  ["вечора", "18:00"],
  ["вечір", "18:00"],
  ["вечером", "18:00"],
  ["вечера", "18:00"],
  ["вечеру", "18:00"],
  ["вечер", "18:00"],
]);

// Words after an hour that say it is in the morning or after noon («на 7 вечора», «о 8 ранку», «в 2 дня»).
export const MORNING: ReadonlySet<string> = new Set(["ранку", "утра", "зранку", "вранці", "утром", "ночі", "ночи"]);
export const AFTERNOON: ReadonlySet<string> = new Set(["вечора", "вечера", "дня", "ввечері", "вечером"]);

// Shop hours: a bare hour from one to seven is after noon («до шостої» is 18:00, «на третю» 15:00): a shop is not open at three in the morning (D66).
export const SHOP_PM_HOURS: readonly [first: number, last: number] = [1, 7];

// Endings of an hour said as an ordinal («шостої», «третю», «сьомої», ru «шестого»): the hour's feminine forms and the date forms.
export const HOUR_ENDINGS = "(ої|ою|ій|ую|ю|а|у|ого|ому|ой|ая|е|ий)";

// The endings of the masculine and neuter forms a day of the month is said in («до п'ятнадцятого», «на десяте», «к первому»): an ordinal with one is an
// hour only with an hour word after it («до шостого часа»), else a day (D67). The feminine forms («до шостої», «на третю») stay hours.
export const DAY_ENDINGS: ReadonlySet<string> = new Set(["ого", "ього", "его", "ьего", "ому", "ьому", "ему", "ьему", "е", "є", "ое", "ье"]);

// Words that say the number before them is a day of the month: «до 5 числа» (D67).
export const DAY_WORDS: ReadonlySet<string> = new Set(["числа", "число"]);

// D92 (P5): the endings a day of the month is written with after its digits («на 21-ше число», «до 18-го», «5-те», ru «21-е», «21-го»): the masculine
// and neuter ordinal endings, uk and ru. The feminine ones («о 5-й», «до 3-ї») stay hours; «5-й» is no day either (ru «пятый» or «пятой»).
export const DAY_DIGIT_ENDINGS: ReadonlySet<string> = new Set(["ше", "ге", "те", "ме", "ве", "ое", "е", "го", "ого", "му", "ому"]);

// Words that say the number before them is an hour: «на три часа дня», «о восьмій годині вечора» (D67).
export const HOUR_WORDS: ReadonlySet<string> = new Set(["година", "годину", "години", "годині", "годин", "час", "часа", "часу", "часов", "часам"]);

// «кінця тижня», «конца месяца»: the end of the current week or month.
export const END_WORDS: ReadonlySet<string> = new Set(["кінця", "кінець", "кінці", "конца", "конец", "конце"]);
export const WEEK_WORDS: ReadonlySet<string> = new Set(["тижня", "тиждень", "тижні", "неделя", "недели", "неделю", "неделе"]);
export const MONTH_WORDS: ReadonlySet<string> = new Set(["місяця", "місяць", "місяці", "месяца", "месяц", "месяце"]);
export const NEXT_WORDS: ReadonlySet<string> = new Set(["наступного", "наступному", "наступний", "наступну", "наступної", "наступна", "следующей", "следующего", "следующий", "следующую", "следующая", "следующем"]);

// «через дві години», «через тиждень»: how far ahead, in hours or days.
export const AHEAD_HOURS: ReadonlySet<string> = new Set(["годину", "години", "годин", "час", "часа", "часов"]);
export const AHEAD_DAYS: ReadonlyMap<string, number> = new Map([
  ["день", 1],
  ["дні", 1],
  ["днів", 1],
  ["дня", 1],
  ["дней", 1],
  ["тиждень", 7],
  ["тижні", 7],
  ["тижнів", 7],
  ["неделю", 7],
  ["недели", 7],
  ["недель", 7],
]);
export const AHEAD_MONTHS: ReadonlySet<string> = new Set(["місяць", "місяці", "місяців", "месяц", "месяца", "месяцев"]);
export const AHEAD = "через";

// Words a `when` span may hold around what it says: prepositions, «годині», «числа», hedges.
export const WHEN_FILLERS: ReadonlySet<string> = new Set([
  "на", "в", "во", "у", "о", "об", "з", "с", "зі", "десь", "приблизно", "где-то", "годині", "години", "годину", "часов", "часа", "час", "числа", "число",
  "цьому", "этом", "цей", "этот", "цього", "этого", "і", "и", "та", "не", "пізніше", "позже", "раніше", "раньше", "прямо",
]);
