// Cyrillic letters (uk and ru) in Latin, for comparing a name said in one script with a catalogue name written in the other (D64, `names.ts` `soundKey`).
// «х» is «h» and «г» is «g»: `soundKey` reads both as one sound, as uk «г» is said like Latin «h».
export const CYRILLIC_LATIN: ReadonlyMap<string, string> = new Map(
  Object.entries({
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    ґ: "g",
    д: "d",
    е: "e",
    є: "ye",
    ё: "yo",
    ж: "zh",
    з: "z",
    и: "i",
    і: "i",
    ї: "yi",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "shch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  }),
);

// Case endings a Cyrillic brand name takes («айфонів», «айфона», «самсунгом», «макбуками»): the spoken word without one of them may sound as the catalogue
// name.
export const CASE_ENDINGS: readonly string[] = ["ами", "ями", "ові", "еві", "ах", "ях", "ів", "ов", "ом", "ем", "ам", "ям", "ою", "ею", "а", "я", "у", "ю", "і", "и", "е", "є", "о"];

// Brand names a letter-by-letter reading does not give, as people say them (D64): the sound rule covers the rest («найк» Nike, «айфон» iPhone, «адідас»
// Adidas, «керастаз» Kérastase). Keep this list short; a brand goes here only when its sound key differs from the spoken form's.
export const BRAND_EXONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["xiaomi", ["сяомі", "сяоми", "ксяомі", "ксяоми"]],
  ["chanel", ["шанель", "шанел"]],
  ["gucci", ["гуччі", "гуччи", "гучі", "гучи"]],
  ["vichy", ["віші", "виши"]],
]);

// Cyrillic letters that look like Latin ones: a model code typed or heard in Cyrillic («ст-с200» for CT-S200, «ртх» for RTX; D66).
export const HOMOGLYPHS: ReadonlyMap<string, string> = new Map(
  Object.entries({ а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i" }),
);

export type SoundRule = readonly [pattern: RegExp, by: string];

// How other languages read a Latin spelling, rules applied to the letters before the English-like reading of `soundKey` (D66): a brand with no spoken form
// in the context is said in one of these. Uppercase letters are sounds the reading keeps («S» ш, «C» ч, «Z» ж).
export const SOUND_READINGS: readonly (readonly SoundRule[])[] = [
  // German and Latin: «Ceresit» «церезит», «Heinz» «хайнц», «Sachs» «закс» «захс», «Staedtler» «штедлер», «Napapijri» «напапійрі».
  [[/^s(?=[tp])/, "S"], [/c(?=[eiy])/g, "ts"], [/z/g, "ts"], [/ch/g, "h"], [/j/g, "y"], [/w/g, "v"], [/dt/g, "d"]],
  // Italian: «Lavazza» «лавацца», «Cimimari» «чимимари», «Gucci» «гуччі».
  [[/sc(?=[ei])/g, "S"], [/c(?=[ei])/g, "C"], [/g(?=[ei])/g, "j"], [/z/g, "ts"], [/gn/g, "ny"]],
  // English beyond the base reading: «Power» «пауер», «Logitech» «логітек», «Nutrition» «нутрішн», «Whey» «вей»; since D71 «FriXion» «фрикшн» and a
  // silent «h» after a vowel, «John» «джон».
  [[/wh/g, "w"], [/(?<=[aeiou])w/g, "u"], [/xion/g, "kSn"], [/[ts]ion/g, "Sn"], [/ch/g, "k"], [/(?<=[aeiou])h(?![aeiouy])/g, ""]],
  // English soft «g»: «Edge» «едж», «Giant» «джайнт».
  [[/dge/g, "j"], [/g(?=[eiy])/g, "j"]],
  // French: «Roche» «рош», «Chanel» «шанель», «Borjomi» «боржомі», «Vichy» «віші».
  [[/ch/g, "S"], [/j/g, "Z"], [/g(?=[eiy])/g, "Z"], [/qu/g, "k"]],
];

// Latin letters said by their names (D71): «аш ем» H&M, «п'ять ве тридцять» 5W30, «эйч энд эм»; each name and the letters it says (uk and ru letter names,
// and the English ones people use for brands). A Cyrillic word said for a one-letter Latin token matches it by name.
export const LETTER_NAMES: ReadonlyMap<string, readonly string[]> = new Map(
  (
    [
      ["а ей эй", "a"], ["бе бі би", "b"], ["це сі си", "c"], ["де ді ди", "d"], ["е і и", "e"], ["еф эф", "f"], ["же ге джи джі", "g"], ["аш ейч эйч хаш", "h"],
      ["ай", "i"], ["жі джей", "j"], ["ка кей", "k"], ["ел ель эл эль", "l"], ["ем эм", "m"], ["ен эн", "n"], ["о оу", "o"], ["пе пі пи", "p"], ["ку кью", "q"],
      ["ер эр ар", "r"], ["ес эс", "s"], ["те ті ти", "t"], ["ю", "u"], ["ве ві ви", "vw"], ["в", "vw"], ["дубльве даблью дабл", "w"], ["ікс икс экс", "x"],
      ["ігрек игрек вай", "y"], ["зет зед", "z"],
    ] as const
  ).flatMap(([names, letters]) => names.split(" ").map((name) => [name, Array.from(letters)] as const)),
);
// «енд», «энд», «and» between two letters said by name is the «&» a brand writes («аш енд ем» H&M), which a name's tokens leave out (D71).
export const AND_NAMES: ReadonlySet<string> = new Set(["енд", "энд", "and", "эн"]);

// uk and ru words with different stems for one thing a catalogue writes in one language (D71; D66 deferred them to a dictionary): colours, berries and a
// few foods («черных» Чорний, «красный» Червоний, «черника» Чорниця, «черничное» Чорниця, «кукурудзяна» Кукуруза, «первого» Першого). A colour adds only
// an ending to its stem (so «розовый» is no «роза», «голубой» no «голубика»); a noun's word is a form of the other word that starts with the other stem.
export type CrossKind = "colour" | "word";
export const CROSS_STEMS: readonly (readonly [uk: string, ru: string, kind: CrossKind])[] = [
  ["чорн", "черн", "colour"], ["червон", "красн", "colour"], ["біл", "бел", "colour"], ["сір", "сер", "colour"], ["жовт", "желт", "colour"],
  ["блакитн", "голуб", "colour"], ["рожев", "розов", "colour"], ["помаранчев", "оранжев", "colour"], ["срібн", "серебрян", "colour"],
  ["срібляст", "серебрист", "colour"], ["прозор", "прозрачн", "colour"], ["світл", "светл", "colour"], ["фіолетов", "фиолетов", "colour"],
  ["бірюзов", "бирюзов", "colour"], ["середн", "средн", "colour"], ["мал", "маленьк", "colour"],
  ["чорни", "черни", "word"], ["полуни", "клубни", "word"], ["суни", "земляни", "word"], ["кукурудз", "кукуруз", "word"], ["горіх", "орех", "word"], ["горіш", "ореш", "word"], ["яблуч", "яблочн", "word"],
  ["яблук", "яблок", "word"], ["часник", "чеснок", "word"], ["цибул", "лук", "word"], ["огір", "огур", "word"], ["огірк", "огурц", "word"],
  ["картопл", "картоф", "word"], ["яловичин", "говядин", "word"], ["вершк", "сливк", "word"], ["вершков", "сливочн", "word"], ["цукр", "сахар", "word"],
  ["цукор", "сахар", "word"], ["борошн", "мук", "word"], ["хліб", "хлеб", "word"], ["перш", "перв", "word"], ["м'ят", "мят", "word"], ["гарбуз", "тыкв", "word"],
];

// Words the recogniser writes for another word inside a name: «того» for the legal form «ТОВ» («того ромашка», D66).
export const ASR_SLIPS: ReadonlyMap<string, string> = new Map([["того", "тов"]]);

// Letter sizes said by their letter names (D65 follow-up): «ем» M, «ікс ел» XL, «ікс ес» XS; a lone «м» or «л» is M or L. A lone «с» is none: it is the
// Russian «with».
export const SIZE_LETTERS: ReadonlyMap<string, string> = new Map([
  ["ікс", "x"],
  ["икс", "x"],
  ["ес", "s"],
  ["эс", "s"],
  ["ем", "m"],
  ["эм", "m"],
  ["м", "m"],
  ["ел", "l"],
  ["ель", "l"],
  ["эл", "l"],
  ["эль", "l"],
  ["л", "l"],
  ["x", "x"],
  ["s", "s"],
  ["m", "m"],
  ["l", "l"],
]);
