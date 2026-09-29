// Words of the v3 period ranges (intents v3 §5.3, D69), uk and ru: quarters, halves, the cumulative nine months, years.

export const QUARTER_WORD = "квартал";
// Ordinals of a quarter or a half by their start: «третій», «третьому», «третьем», «первое».
export const QUARTER_ORDINALS: readonly (readonly [stem: string, value: number])[] = [
  ["перш", 1], ["перв", 1], ["друг", 2], ["втор", 2], ["трет", 3], ["четверт", 4], ["четвёрт", 4],
];
export const HALF_WORDS: readonly string[] = ["півріч", "полугод", "піврок"];
export const NINE_MONTHS: readonly string[] = ["9 місяців", "дев'ять місяців", "9 месяцев", "девять месяцев"];
export const THREE_QUARTERS: readonly string[] = ["три квартали", "три квартала", "3 квартали", "3 квартала"];
export const YEAR_WORDS: readonly string[] = ["рік", "року", "році", "рок", "год", "года", "году"];
// A year said by its place from this one, with a year word after it: «позаминулий рік» −2, «минулого року» −1, «цього року» 0.
export const RELATIVE_YEARS: readonly (readonly [stem: string, offset: number])[] = [
  ["позаминул", -2], ["позапрошл", -2], ["минул", -1], ["прошл", -1], ["торішн", -1], ["цьог", 0], ["цей", 0], ["этог", 0], ["этот", 0], ["поточн", 0], ["текущ", 0],
];
