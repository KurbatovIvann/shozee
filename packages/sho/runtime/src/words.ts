import { ADJECTIVE_ENDINGS } from "./lexicon/catalogue.ts";
import { familyTails, undoubled } from "./morphology.ts";

const LETTERS = /^\p{L}+$/u;

// Whether a word is letters only, as read before: catalogue words are tested again with every word said.
const LETTERED = new Map<string, boolean>();
const LETTERED_KEPT = 100_000;

export function lettersOnly(text: string): boolean {
  const known = LETTERED.get(text);
  if (known !== undefined) return known;
  if (LETTERED.size >= LETTERED_KEPT) LETTERED.clear();
  const letters = LETTERS.test(text);
  LETTERED.set(text, letters);
  return letters;
}

export function adjectiveLike(text: string): boolean {
  return !text.includes(" ") && ADJECTIVE_ENDINGS.some((ending) => text.endsWith(ending));
}

export function commonPrefix(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

// Enough letters in common at the start, whatever follows (D56): the rule names are matched by, where a short form («Влад» of «Владислав») and a case form
// alike start the known word. Catalogue words take `wordMatch`, which also asks what follows.
// D82: a word of four letters or fewer is shared whole («влад» «владислава»); one that differs in its last letter is no prefix («олени» is no «Олег»,
// «петренка» no «Петя»): a case form with a changed last letter is `caseForm`'s («каті» Катя, «надю» Надя, `nameList.ts`).
export function startsAlike(spoken: string, known: string): boolean {
  if (spoken === known) return true;
  if (!lettersOnly(spoken) || !lettersOnly(known)) return false;
  const shorter = Math.min(Array.from(spoken).length, Array.from(known).length);
  const shared = commonPrefix(spoken, known);
  if (shorter <= 4) return shared >= shorter && shared >= 3;
  return shared >= 4 && shared >= 0.6 * shorter;
}

// Two words of one family by their start: enough letters in common at the start, and after them only word-building suffixes and endings on either side
// («малиновий» «малина», «ваніллю» «ванільний», «торти» «торт»; not «фарбекс» «фарба», «тепловентилятор» «тепловий», «powerade» «power»: D66). A doubled
// letter counts once («круассан» «круасан»). The stem may end before the letters in common do: «малино|ю» and «малин|овий» share «малино».
// uk and ru spellings of one loanword differ by a vowel («картрідер» «картридер», D71): letters of one class.
const SPELLING_VOWELS: ReadonlyMap<string, string> = new Map([["і", "и"], ["ы", "и"], ["э", "е"], ["є", "е"], ["ё", "е"]]);
// The shortest loanword compared so; shorter words differ by a vowel as different words do.
const SPELLED_LENGTH = 6;

// uk «і» for «о» / «е», and «о» for «е», where the words part; not uk «і» for ru «и» («ваниль» is no «ванільний»).
const PARTING_VOWELS = "оеі";
// The stem it follows says at least this much («творч»): «цук|о|р» is no «цук|е|рки».
const PARTING_STEM = 5;

function alternatingAt(said: string, name: string, at: number): boolean {
  const left = Array.from(said)[at];
  const right = Array.from(name)[at];
  return left !== undefined && right !== undefined && left !== right && PARTING_VOWELS.includes(left) && PARTING_VOWELS.includes(right);
}

function oneVowelApart(said: string, name: string): boolean {
  const left = Array.from(said);
  const right = Array.from(name);
  if (left.length !== right.length || left.length < SPELLED_LENGTH) return false;
  const apart = left.flatMap((letter, index) => (letter === right[index] ? [] : [index]));
  const [at] = apart;
  return apart.length === 1 && at !== undefined && (SPELLING_VOWELS.get(left[at] ?? "") ?? left[at]) === (SPELLING_VOWELS.get(right[at] ?? "") ?? right[at]);
}

export function wordMatch(spoken: string, known: string): boolean {
  if (spoken === known) return true;
  if (!lettersOnly(spoken) || !lettersOnly(known)) return false;
  const said = undoubled(spoken);
  const name = undoubled(known);
  if (oneVowelApart(said, name)) return true;
  const shorter = Math.min(Array.from(said).length, Array.from(name).length);
  const least = shorter <= 4 ? Math.max(3, shorter - 1) : Math.max(4, Math.ceil(0.6 * shorter));
  const shared = commonPrefix(said, name);
  // A stem vowel that alternates right where the words part counts as shared (D71: «творч|о|сті» «творч|е|ство», «творч|і|сть»); `familyTails` still asks
  // what follows it.
  const alternating = shared >= PARTING_STEM && alternatingAt(said, name, shared) ? 1 : 0;
  for (let stem = shared; stem + (stem === shared ? alternating : 0) >= least; stem--) if (familyTails(said, name, stem)) return true;
  return false;
}
