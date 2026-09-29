import { LEGAL_FORMS } from "./lexicon/customers.ts";
import { FIRST_NAME_GROUPS } from "./lexicon/firstNames.ts";

// A person's gender by a name (D79 pronouns; D82 the nominative of a name said in another case, `nominative.ts`).

// Women's first names that end in a consonant, men's that end in «а» / «я», and short forms both use.
const MEN_IN_A: ReadonlySet<string> = new Set(["микола", "ілля", "илья", "никита", "кузьма", "лука", "фома", "сава", "данила", "гаврила", "савва", "фока"]);
const EITHER: ReadonlySet<string> = new Set(["саша", "женя", "валя", "шура", "слава", "стася"]);
const WOMEN_IN_CONSONANT: ReadonlySet<string> = new Set(["любов", "любовь", "нінель", "есфір"]);
const FIRST_NAMES: ReadonlySet<string> = new Set(FIRST_NAME_GROUPS.flat());
const FEMININE_PATRONYMIC = /(івна|ївна|овна|евна|ична|инична)$/;
const MASCULINE_PATRONYMIC = /(ович|евич|йович|ьович|іч|ич)$/;
const FEMININE_SURNAME = /(ська|цька|зька|ская|цкая)$/;
const MASCULINE_SURNAME = /(ський|цький|зький|ский|цкий)$/;

export type Gender = "feminine" | "masculine";

export function firstNameGender(word: string): Gender | null {
  if (EITHER.has(word)) return null;
  if (WOMEN_IN_CONSONANT.has(word)) return "feminine";
  if (MEN_IN_A.has(word)) return "masculine";
  return /[ая]$/.test(word) ? "feminine" : "masculine";
}

// A person's gender by the name a record has: a first name the lexicon knows, a patronymic, a surname of the «-ська» kind, else a person's first word as
// a first name; null when it cannot be told (a firm, a short form both use).
export function nameGender(name: string): Gender | null {
  const all = name.toLowerCase().replace(/[«»"]/g, " ").split(/\s+/).filter(Boolean);
  const words = all.filter((word) => !LEGAL_FORMS.has(word));
  // A firm («ТОВ «Лілея Сервіс»», «Салон краси «Півонія»») is no person: only a patronymic or a first name the lexicon knows says one.
  const person = words.length === all.length && !/[«»"]/.test(name);
  const known = words.find((word) => FIRST_NAMES.has(word));
  if (known !== undefined) return firstNameGender(known);
  for (const word of words) {
    if (FEMININE_PATRONYMIC.test(word) || FEMININE_SURNAME.test(word)) return "feminine";
    if (MASCULINE_PATRONYMIC.test(word) || MASCULINE_SURNAME.test(word)) return "masculine";
  }
  const [first] = words;
  return person && words.length >= 2 && first !== undefined && /^[а-яіїєґё'-]+$/.test(first) ? firstNameGender(first) : null;
}
