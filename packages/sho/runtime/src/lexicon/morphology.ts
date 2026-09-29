// Endings and word-building suffixes of uk and ru nouns and adjectives (D66, `morphology.ts`): what a word may add to its stem.

// Inflectional endings, nouns and adjectives of both languages, soft and hard stems: «ручк|а», «замк|ів», «біл|ого», «син|ього», ru «син|юю», «лит|ые».
export const INFLECTIONS: readonly string[] = [
  "ьому", "ього", "ьої", "ьою",
  "ого", "его", "ому", "ему", "ими", "ыми", "іми", "ами", "ями", "ові", "еві", "єві",
  "ий", "ій", "ый", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ою", "ею", "єю", "ої", "еї", "их", "ых", "іх", "им", "ым", "ім",
  "ах", "ях", "ів", "їв", "ов", "ев", "ей", "ам", "ям", "ом", "ем", "єм",
  "а", "я", "у", "ю", "і", "ї", "и", "ы", "е", "є", "о",
  // Nouns in «-ія» / ru «-ия» and «-ье» («Бессарабія» «Бессарабии», «Василию», «варенья»).
  "іями", "іях", "іям", "ією", "ієм", "ія", "ію", "ії",
  "иями", "иях", "иям", "ией", "ием", "ия", "ию", "ии",
  "ьем", "ье", "ья", "ьи", "ью",
];

// Suffixes that make a word from a stem: an adjective from a noun («малин|ов|ий», «ваніль|н|ий»), a diminutive («торт|ик», «фісташ|к|а», «кекс|ик»).
// A word differs from another word of its family only by these and an ending; «фарб|екс» and «терм|опару» do not (D66).
// Since D71 the abstract-noun suffixes «-ість» / «-ост-» and ru «-ость», «-ество» («творчості», «творчість», ru «творчества»).
export const DERIVATIONS: readonly string[] = [
  "ирован", "ірован", "ован", "уван", "ическ", "ичн", "ічн", "еств", "ств", "іст", "ост",
  "еньк", "оньк", "очк", "ечк", "ичк", "ушк", "юшк", "ськ", "цьк", "зьк", "чик",
  "ов", "ев", "єв", "ів", "ин", "ян", "ан", "ен", "еск", "ск", "ок", "ек", "ик", "ік", "ець", "ец",
  "н", "к", "ц", "л", "ь",
];

// Consonants that alternate where a stem meets a suffix or an ending: «горі|х» — «горі|шк|и», «полуни|ц|я» — «полуни|ч|н|ий», «клубни|к|а» — «клубни|ч|н|ый».
export const ALTERNATING: readonly (readonly string[])[] = [
  ["к", "ч", "ц", "щ"],
  ["г", "ж", "з"],
  ["х", "ш", "с", "щ"],
];

// Stem vowels that alternate inside a word family or between uk and ru spellings of one word: «сковорідок» «сковорода», «пломбір» «пломбир», «парфуми»
// «парфюм» (D66).
export const ALTERNATING_VOWELS: readonly (readonly string[])[] = [
  ["і", "и", "е", "о", "ы"],
  ["у", "ю"],
  ["а", "я"],
];

// Letters that end a stem before «і» in the dative and locative, with the letter the other forms have: «нит|ц|і» — «нит|к|а», «но|з|і» — «но|г|а», «му|с|і» —
// «му|х|а» (uk first declension).
export const SOFTENED: ReadonlyMap<string, string> = new Map([
  ["ц", "к"],
  ["з", "г"],
  ["с", "х"],
]);

// The ending after which the stem's last consonant is softened.
export const SOFTENING_ENDING = "і";

// The «й» of a noun's stem stands where its other forms have an iotated vowel: «алюміні|й» «алюміні|єв|ий», «ча|й» «ча|ю», «Андрі|й» «Андрі|я»; «мали|й»
// is no form of «мали|новий».
export const STEM_J = "й";
export const IOTATED_VOWELS = "єюяї";

// Russian reflexive participles and adjectives end in «-ся» / «-сь» after the ending («самоклеящиеся», «самоклеящихся», «самоконтрящаяся», D71): the word
// is read without it.
export const REFLEXIVE_ENDINGS: readonly string[] = ["ся", "сь"];

// Russian neuter nouns in «-мя» whose other forms add «-ен-» («семя», «семени», «семена», «семян», D71): their stems, read without it.
export const N_STEMS: readonly string[] = ["сем", "врем", "им", "знам", "плам", "плем", "стрем", "тем", "вым", "брем"];

// Latin endings a Latin word may add: a plural («airpods» of «AirPods»).
export const LATIN_ENDINGS: readonly string[] = ["", "s", "es"];
