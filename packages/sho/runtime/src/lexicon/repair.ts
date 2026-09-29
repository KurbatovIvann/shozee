// «ані» is «а ні» as the recogniser writes it (Chrome ASR, D61): the same marker everywhere, never a word of an item list.
// D72: «ні-ні», «нет-нет», «переплутала» as the stage-1 dictation says them.
export const REPAIR_MARKERS: readonly string[] = ["ой", "ой ні", "ні", "а ні", "ані", "вірніше", "точніше", "тобто", "ой нет", "а нет", "нет", "точнее", "вернее", "чекай",
  "ні-ні", "нет-нет", "переплутала", "переплутав", "перепутала", "перепутал"];
// D72: phrases of common words that are a marker only as a whole («ой не те», «стоп не так»): never a marker word alone, so «так», «не», «те» and «стоп»
// stay what they are elsewhere (`repair.ts` `REPAIR_WORDS` holds only the words of `REPAIR_MARKERS`).
export const PHRASE_MARKERS: readonly string[] = ["не те", "не так", "стоп не так", "стоп не те"];
export const LONE_MARKERS: ReadonlySet<string> = new Set(["ні", "нет"]);

// «стоп», «почекай», «подожди» repair only together with a marker («а ні стоп», «стоп ні», «ой почекай»); a bare one is left alone (it may end the order).
export const HALT_WORDS: readonly string[] = ["стоп", "почекай", "подожди", "стривай", "погоди"];
const HALT_PATTERNS: readonly string[] = ["а ні _", "ані _", "ні _", "_ ні", "ой _", "а нет _", "нет _", "_ нет"];
export const COMBINED_MARKERS: readonly string[] = HALT_WORDS.flatMap((halt) => HALT_PATTERNS.map((pattern) => pattern.replace("_", halt)));

// Going back to an earlier value (D59): «хоча ні, все-таки медовий». These repair only between two values of the same kind (`repair.ts` `strengthOf`).
export const BACK_MARKERS: readonly string[] = [
  "хоча ні",
  "хоча",
  "ні правильно",
  "правильно",
  "все-таки",
  "все таки",
  "все ж таки",
  "все ж-таки",
  "таки",
  "хотя нет",
  "хотя",
  "нет правильно",
  "всё-таки",
  "всё таки",
];

// An additive cue before a quantity that repeats the line before (D60): «4 круасана ще додай 5» adds 5 to the круасан line. The gap is an optional joiner
// and one of these, hedges left out (`repair.ts` `additive`): «ще», a verb before or after it, and a lead word before both («давай ще додамо», «і візьми ще
// додай», ru «давай ещё добавим»).
const MORE: readonly string[] = ["ще", "ещё", "еще"];
const ADD_VERBS: readonly string[] = ["додай", "додайте", "додамо", "добавь", "добавьте", "добавим"];
const LETS: readonly string[] = ["давай", "давайте"];
// Order verbs and the addressee that only introduce the next item (lh-414 «… ще додай 5 і візьми ще додай макарони …»), uk and ru; «запиши» is both.
// Like «додай» they are a gap by themselves and part of a cue with «ще»: «візьми ще 5», «мені ще 5», «ще візьми 5».
const ORDER_VERBS: readonly string[] = ["візьми", "візьміть", "запиши", "запишіть", "постав", "поставте", "дай", "дайте", "хочу", "хочемо", "возьми", "возьмите", "запишите", "поставь", "поставьте", "хотим"];
const ADDRESSEES: readonly string[] = ["нам", "мені", "мне"];
const VERBS: readonly string[] = [...ADD_VERBS, ...ORDER_VERBS, ...ADDRESSEES];
const LEADS: readonly string[] = [...LETS, ...ORDER_VERBS, ...ADDRESSEES];
const MORE_PHRASES: readonly string[] = MORE.flatMap((more) => [more, ...VERBS.flatMap((verb) => [`${more} ${verb}`, `${verb} ${more}`])]);
export const ADD_CUES: readonly string[] = [...new Set([...MORE_PHRASES, ...LEADS.flatMap((lead) => MORE_PHRASES.map((phrase) => `${lead} ${phrase}`))])];
export const ADD_JOINERS: ReadonlySet<string> = new Set(["і", "й", "та", "и", "а"]);

// The words that only introduce more items (D60): the cue words above, and «плюс», «давай додамо», «додай», «і візьми» that no «ще» makes a cue. Never a
// product, a flavour or a value a repair replaces: the catalogue pass reads them as gaps (`CONNECTORS`) and the model's spans lose them at their edges, with
// a joiner said right before them («а ще», «і візьми»).
export const ITEM_LEAD_WORDS: ReadonlySet<string> = new Set([...MORE, ...VERBS, ...LETS, "плюс"]);

// Hedges (D60): filler that changes nothing in an item list. Never a product, a marker or a cue word, and «приблизно», «десь» leave the number as said.
// «ну» is a joiner as well (`CONNECTORS`) and stays in the gap as one.
// D72: hesitation sounds («е-е», «е-е-е», «ммм», «хм») are hedges too: never a product, a flavour or a value (lh-233 «… з фісташкою 8. Е-е, додай брауні»);
// «мм» is millimetres, not a hesitation.
export const HEDGE_WORDS: ReadonlySet<string> = new Set(["напевно", "мабуть", "навєрно", "наверное", "наверно", "типу", "ну", "десь", "приблизно", "где-то",
  "е-е", "е-е-е", "ее", "еее", "э-э", "э-э-э", "ээ", "эээ", "а-а", "м-м", "ммм", "хм", "гм"]);
