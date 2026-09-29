// D78: the kinds of an order line's attribute words, for the attrs the model tags apart and the runtime used to join (`attrKinds.ts`): colours and size
// words by their stems in uk and ru, with an adjective's ending.

// Colour stems (uk and ru), each read with one of `ATTR_ENDINGS` («чорн|ий», «біл|у», «черн|ые», «син|ю»). «малинов», «вишнев», «шоколад» are flavours as
// often as colours and stay out; «золот» is here for «золотий» (the noun «золото» takes no adjective ending).
export const COLOUR_STEMS: readonly string[] = [
  "чорн", "черн", "біл", "бел", "червон", "красн", "сір", "сер", "син", "зелен", "зелён", "жовт", "желт", "жёлт", "блакитн", "голуб", "рожев", "розов",
  "помаранчев", "оранжев", "фіолетов", "фиолетов", "коричнев", "бежев", "бордов", "бірюзов", "бирюзов", "срібн", "срібляст", "серебрян", "серебрист",
  "золот", "графітов", "графитов", "кремов", "пудров", "персиков", "м'ятн", "мятн", "лілов", "лилов", "бузков", "сиренев", "молочн", "титанов",
];

// Latin colour words a recogniser writes as said («black», «space gray»).
export const LATIN_COLOURS: ReadonlySet<string> = new Set(["black", "white", "red", "blue", "green", "grey", "gray", "pink", "silver", "gold", "beige", "purple", "yellow", "orange", "brown", "navy"]);

// Words that say a size and no colour («великий», «малий», «середній», ru «большой», «маленький», «средний»), by stem, with `ATTR_ENDINGS`.
export const SIZE_STEMS: readonly string[] = ["велик", "мал", "маленьк", "середн", "средн", "больш", "крупн", "дрібн", "мелк"];

// The endings of an adjective in uk and ru, every gender, number and case.
export const ATTR_ENDINGS: ReadonlySet<string> = new Set([
  "ий", "ій", "ый", "ой", "а", "я", "е", "є", "і", "и", "у", "ю", "ого", "ього", "его", "ому", "ьому", "ему", "ої", "ьої", "ою", "ьою", "им", "ім", "ими",
  "іми", "их", "іх", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ей", "ых", "ым", "ыми",
]);

// A word that reads as an adjective when no stem above holds it («вечірня», «базову», «зволожуючий», «шоколадних»): one of these endings, five letters
// or more. A noun with such an ending («малина», «вишня») is read as one too; it matters only next to a colour («чорна малина» would be two attrs).
export const ADJECTIVE_TAILS: readonly string[] = [
  "ий", "ій", "ый", "ой", "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "их", "іх", "ых", "ого", "его", "ього", "ому", "ему", "ої", "ою",
  "на", "ні", "не", "ну", "ва", "ві", "ве", "ву", "ня", "ню",
];
