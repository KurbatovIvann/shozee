import { firstNameGender, type Gender } from "./gender.ts";
import { FIRST_NAME_GROUPS, MORE_FIRST_NAMES } from "./lexicon/firstNames.ts";
import { endingForm } from "./nameList.ts";
import { commonPrefix } from "./words.ts";

// D82 (E3): the nominative of a new customer's name said in another case, for the card's create suggestion (`suggest.ts`): «для гришу» Гриша, «оксану
// осадчу» Оксана Осадча, «миколи тищенка» Микола Тищенко. The first word must be a first name the lexicon knows (`lexicon/firstNames.ts`), read back to
// the lexicon's form it is a case form of (the stem and a name ending, `endingForm`); the words after it are a surname or a patronymic read back by the
// endings of the first name's gender. A word that cannot be read back surely (a man's surname in «-я» or «-ю»: «журавля», «вишню») gives no nominative at
// all, never half a name; so does a name that starts with no first name («кафе ранок»). The words said stay the suggestion's `text`.

const FIRST_NAMES: readonly string[] = [...new Set([...FIRST_NAME_GROUPS.flat(), ...MORE_FIRST_NAMES])];
const MOST_WORDS = 3;

type Rule = readonly [pattern: RegExp, ending: string];

// A man's surname or patronymic in another case, and its nominative ending (the stem kept is the pattern's group): «тищенка» Тищенко, «бойка» Бойко (a
// consonant before «к»), «ковальського» Ковальський, «миколайовича» Миколайович, «мельника» Мельник, «павлова» Павлов.
const MASCULINE: readonly Rule[] = [
  [/^(.+енк)(?:а|у|ові|ом)$/u, "о"],
  [/^(.+[сцз]ьк)(?:ого|ому|им)$/u, "ий"],
  [/^(.+[сцз]к)(?:ого|ому|им)$/u, "ий"],
  [/^(.+[оеє]вич)(?:а|у|ем|еві)$/u, ""],
  [/^(.+[бвгджзлмнпрстфхцчшщй]к)(?:а|у|ові|ом)$/u, "о"],
  [/^(.+[бвгджзклмнпрстфхцчшщ])(?:а|у|ові|ом|ем)$/u, ""],
];

// A woman's surname or patronymic in another case: adjective-like and «-ова» / «-іна» surnames, patronymics, then any «-у» / «-ю» / «-ої» / «-ій» / «-ою»
// of a surname in «-а» / «-я» («осадчу» Осадча).
const FEMININE: readonly Rule[] = [
  [/^(.+[сцз]ьк)(?:у|ої|ій|ою)$/u, "а"],
  [/^(.+[сцз]к)(?:ую|ой|ою)$/u, "ая"],
  [/^(.+[іїе]вн)(?:и|і|у|ою)$/u, "а"],
  [/^(.+)(?:у|ої|ій|ою|ой)$/u, "а"],
  [/^(.+)ю$/u, "я"],
];

// A surname already in the nominative, of either gender: it ends in a consonant or «-о» but not «-ого» («мельник», «петренко», «колесо»); a man's also in
// «-ий» / «-ій» / «-ич», a woman's in «-а» / «-я».
const EITHER_NOMINATIVE = /(?:[бвгґджзклмнпрстфхцчшщь]|о)$/u;
const ADJECTIVE_CASE = /(?:ого|его|ього)$/u;
const MASCULINE_NOMINATIVE = /(?:ий|ій|ич)$/u;
const FEMININE_NOMINATIVE = /[ая]$/u;

// What a surname or patronymic in the nominative ends in; a word said after the name that reads back to none of these («ламінат», «блуза», «онлайн»: a
// product or a word the model's customer span swallowed) gives no nominative.
const NAME_SHAPED = /(?:енко|ко|[уюаяиі]к|ник|ич|ець|ль|[ая]р|[оеє]в|[іиї]н|[сцз]ьк(?:ий|а)|[сцз]к(?:ий|ая)|[оеє]ва|[іиї]на|ча|чий|вна)$/u;

function nominativeLike(word: string): boolean {
  return EITHER_NOMINATIVE.test(word) && !ADJECTIVE_CASE.test(word);
}

function readBack(rules: readonly Rule[], word: string): string | null {
  for (const [pattern, ending] of rules) {
    const found = pattern.exec(word);
    if (found !== null) return `${found[1] ?? ""}${ending}`;
  }
  return null;
}

// A word said after a first name in another case, in the nominative by the gender; null when it cannot be told. A name both use («саша») is a man's
// when the surname is in a man's case (a woman's «-енко», «-ук» or «-ник» surname does not change).
function surname(word: string, gender: Gender | null): string | null {
  if (gender === "masculine") return readBack(MASCULINE, word) ?? (nominativeLike(word) || MASCULINE_NOMINATIVE.test(word) ? word : null);
  if (gender === "feminine") return readBack(FEMININE, word) ?? (nominativeLike(word) || FEMININE_NOMINATIVE.test(word) ? word : null);
  return nominativeLike(word) ? word : readBack(MASCULINE, word);
}

// The lexicon's first names a word is a case form of, the one that shares most letters with it first; the word itself when it is one.
function firstNameForms(word: string): readonly string[] {
  const own = FIRST_NAMES.includes(word) ? [word] : [];
  const forms = FIRST_NAMES.filter((form) => form !== word && endingForm(word, form)).toSorted((left, right) => commonPrefix(word, right) - commonPrefix(word, left));
  return [...own, ...forms];
}

function capital(word: string): string {
  return word.split("-").map((part) => (part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part)).join("-");
}

// The name in the nominative, each word capitalised, when it differs from the words said; null when the words are already so or cannot be read back. A
// first name said in the nominative leaves the words after it as said (they agree with it: «олег сковорода» is no «сковород»).
export function nominativeName(text: string): string | null {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const [first, ...rest] = words;
  if (first === undefined || words.length > MOST_WORDS) return null;
  // A word that is a first name and a case form of another («олександра» Олександра, or Олександр's genitive): the man's when the surname is in a man's
  // case.
  const readings = firstNameForms(first).flatMap((form) => {
    if (form === first) return [{ form, after: rest, manly: false }];
    const gender = firstNameGender(form);
    const after = rest.map((word) => surname(word, gender));
    const manly = gender === "masculine" && rest.some((word) => !nominativeLike(word) && readBack(MASCULINE, word) !== null);
    return after.every((word) => word !== null && NAME_SHAPED.test(word)) ? [{ form, after: after.flatMap((word) => (word === null ? [] : [word])), manly }] : [];
  });
  const reading = readings.find((one) => one.manly) ?? readings[0];
  if (reading === undefined) return null;
  const name = [reading.form, ...reading.after].map(capital).join(" ");
  return name.toLowerCase() === words.join(" ") ? null : name;
}
