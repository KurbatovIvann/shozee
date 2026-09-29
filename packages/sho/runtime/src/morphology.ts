import { ALTERNATING, ALTERNATING_VOWELS, DERIVATIONS, INFLECTIONS, IOTATED_VOWELS, LATIN_ENDINGS, N_STEMS, REFLEXIVE_ENDINGS, SOFTENED, SOFTENING_ENDING, STEM_J } from "./lexicon/morphology.ts";

// Word forms of uk and ru nouns and adjectives by their paradigm (D66). A word is a stem and an inflectional ending; the stem's last syllable may lose or
// gain a vowel («ручка» «ручок», «замок» «замків», «пензель» «пензлів», «окно» «окон», «яйце» «яєць», ru «гайка» «гаек»), change «і» to «о» or «е» (uk:
// «ніж» «ножа», «сіль» «солі», «папір» «паперу», «ягода» «ягід»), and soften «к», «г», «х» to «ц», «з», «с» before «і» («нитка» «нитці», «Віка» «віці»).
// Two words are forms of one word when a reading of each (a stem and what its last syllable may do) comes out the same. Only whole endings are taken off:
// «фарбекс» is no form of «фарба», nor «термопару» of «термія».

const VOWELS = "аеєиіїоуюяыэё";
const IOTATED: ReadonlyMap<string, string> = new Map([
  ["є", "йе"],
  ["ю", "йу"],
  ["я", "йа"],
  ["ї", "йі"],
  ["е", "йе"],
]);
const CYRILLIC = /^\p{Script=Cyrillic}+$/u;
const LATIN = /^[a-z]+$/;
// The shortest stem a reading keeps, and the shortest word read: «гра» «гру» (stem «гр»), «туя» «туй» (stem «ту»).
const SHORTEST_STEM = 2;
const SHORTEST_WORD = 3;
// A vowel that drops or alternates sits in the stem's last syllable, before one consonant: «руч|о|к», «н|і|ж»; «тісто» is no form of «тост».
const FLEETING = new RegExp(`^(.*[^${VOWELS}])[ое]([^${VOWELS}])$`, "u");
// Since D71 before one or two consonants: «хв|і|ст» «хв|о|ста», «ніжн|і|сть» «ніжн|о|сті»; and a stem «й» counts as a consonant («нап|і|й» «нап|о|ю»).
const ALTERNATING_VOWEL = new RegExp(`^(.*[^${VOWELS}])([іое])([^${VOWELS}]{1,2})$`, "u");
const N_STEM = new RegExp(`^(${N_STEMS.join("|")})(?:ен|ян)$`, "u");
const WILD = "~";

// A word's readings: stems as they are (`plain`), and stems whose last-syllable vowel was «і» (`fromI`) or «о»/«е» (`fromOE`), that vowel written `~`. «ніж»
// and «ножа» meet only as `fromI` and `fromOE`: two words that both have «о» or «е» there are not forms of one word («торт» is no «терт»). Since D71 an «і»
// alternates with «о» / «е» only in a closed syllable, a word with no ending («ніж», «хвіст», «творчість»); in an open one («бігу», «тісто») it is the uk
// spelling of a ru «е» only (`fromIE` meets `fromE`: «бігу» «бега», «тісто» «тесто», but «тісто» is no «тост»).
export interface WordForms {
  readonly plain: ReadonlySet<string>;
  readonly fromI: ReadonlySet<string>;
  readonly fromOE: ReadonlySet<string>;
  readonly fromIE: ReadonlySet<string>;
  readonly fromE: ReadonlySet<string>;
}

const NO_FORMS: WordForms = { plain: new Set(), fromI: new Set(), fromOE: new Set(), fromIE: new Set(), fromE: new Set() };

type Forms = { plain: Set<string>; fromI: Set<string>; fromOE: Set<string>; fromIE: Set<string>; fromE: Set<string> };

// Where a stem's alternating vowel goes: «і» in a closed syllable (no ending) to `fromI`, in an open one to `fromIE`; «о», «е» to `fromOE`, and «е» also
// to `fromE`.
function alternated(found: RegExpExecArray | null, ending: string, forms: Forms, keep: (set: Set<string>, key: string) => void): void {
  if (found === null) return;
  const key = `${found[1] ?? ""}${WILD}${found[3] ?? ""}`;
  if (found[2] === "і") keep(ending === "" ? forms.fromI : forms.fromIE, key);
  else {
    keep(forms.fromOE, key);
    if (found[2] === "е") keep(forms.fromE, key);
  }
}

// Letters written alike for this purpose: «ё» is «е», ru «э» is «е» («алоэ» «алое»), «ґ» is «г», «щ» is «ш» («дошка» «дощок»); apostrophes go.
function plainLetters(word: string): string {
  return word.toLowerCase().replace(/[ёэ]/g, "е").replace(/ґ/g, "г").replace(/щ/g, "ш").replace(/['’ʼ]/g, "");
}

function isVowel(letter: string | undefined): boolean {
  return letter !== undefined && VOWELS.includes(letter);
}

// «яєць» → «яйець», ru «гаек» → «гайек»: a vowel letter after a vowel says «й» and the vowel, so the «й» of «яйце» and «гайка» is found in every form.
function iotated(stem: string): string {
  const letters = Array.from(stem);
  return letters.map((letter, index) => (index > 0 && isVowel(letters[index - 1]) ? (IOTATED.get(letter) ?? letter) : letter)).join("");
}

// The stem as it is compared: iotated vowels spelled out, no soft or hard sign, no «й» at the end («туй» «ту|я», «мрій» «мрі|я»).
function skeleton(stem: string): string {
  return iotated(stem).replace(/[ьъ]/g, "").replace(/й$/, "");
}

function letterCount(key: string): number {
  return key.replace(WILD, "").length;
}

// The stem with its «й»: before an ending that starts with an iotated vowel after the stem's vowel («напо|їв», «напо|ю»), the «й» that vowel says belongs
// to the stem («напой», as «напій»), for the vowel that alternates before it (D71).
function withJ(stem: string, ending: string): string {
  const full = iotated(stem).replace(/[ьъ]/g, "");
  return isVowel(Array.from(full).at(-1)) && IOTATED_VOWELS.includes(ending[0] ?? "") ? `${full}${STEM_J}` : full;
}

function readings(stem: string, ending: string, forms: Forms): void {
  const base = skeleton(stem);
  const keep = (set: Set<string>, key: string) => {
    if (letterCount(key) >= SHORTEST_STEM) set.add(key);
  };
  keep(forms.plain, base);
  const nStem = N_STEM.exec(base);
  if (nStem !== null) keep(forms.plain, nStem[1] ?? "");
  const jStem = withJ(stem, ending);
  const jVowel = jStem.endsWith(STEM_J) ? ALTERNATING_VOWEL.exec(jStem) : null;
  alternated(jVowel, ending, forms, keep);
  const fleeting = FLEETING.exec(base);
  if (fleeting !== null) keep(forms.plain, `${fleeting[1] ?? ""}${fleeting[2] ?? ""}`);
  const softened = ending === SOFTENING_ENDING ? SOFTENED.get(base.slice(-1)) : undefined;
  if (softened !== undefined) keep(forms.plain, `${base.slice(0, -1)}${softened}`);
  alternated(ALTERNATING_VOWEL.exec(base), ending, forms, keep);
}

function readForms(word: string): WordForms {
  const said = plainLetters(word);
  const reflexive = REFLEXIVE_ENDINGS.find((ending) => said.endsWith(ending) && Array.from(said).length - ending.length >= SHORTEST_WORD + 2);
  const letters = reflexive === undefined ? said : said.slice(0, -reflexive.length);
  if (!CYRILLIC.test(letters) || Array.from(letters).length < SHORTEST_WORD) return NO_FORMS;
  const forms: Forms = { plain: new Set<string>(), fromI: new Set<string>(), fromOE: new Set<string>(), fromIE: new Set<string>(), fromE: new Set<string>() };
  for (const ending of ["", ...INFLECTIONS]) {
    if (!letters.endsWith(ending) || Array.from(letters).length - Array.from(ending).length < SHORTEST_STEM) continue;
    readings(ending ? letters.slice(0, -ending.length) : letters, ending, forms);
  }
  return forms;
}

// Forms already read: a catalogue's words are compared with every word said.
const FORMS = new Map<string, WordForms>();
const FORMS_KEPT = 100_000;

export function wordForms(word: string): WordForms {
  const known = FORMS.get(word);
  if (known !== undefined) return known;
  if (FORMS.size >= FORMS_KEPT) FORMS.clear();
  const forms = readForms(word);
  FORMS.set(word, forms);
  return forms;
}

function meets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const key of left) if (right.has(key)) return true;
  return false;
}

// Whether two Cyrillic words are forms of one word by their paradigm.
export function sameWord(spoken: string, known: string): boolean {
  if (spoken === known) return true;
  const said = wordForms(spoken);
  const name = wordForms(known);
  return meets(said.plain, name.plain) || meets(said.fromI, name.fromOE) || meets(said.fromOE, name.fromI) || meets(said.fromIE, name.fromE) || meets(said.fromE, name.fromIE);
}

// Every key a word's forms may meet another word's by: a necessary condition of `sameWord`, for a token index.
export function formKeys(word: string): string[] {
  const forms = wordForms(word);
  return [...new Set([...forms.plain, ...forms.fromI, ...forms.fromOE, ...forms.fromIE])];
}

// Whether `rest` is what a word of the family adds to the stem: word-building suffixes, then an ending (or none).
export function suffixed(rest: string): boolean {
  if (rest === "" || INFLECTIONS.includes(rest)) return true;
  return DERIVATIONS.some((suffix) => rest.startsWith(suffix) && suffixed(rest.slice(suffix.length)));
}

function alternates(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right && ALTERNATING.some((group) => group.includes(left) && group.includes(right));
}

function vowelsAlternate(left: string | undefined, right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right && ALTERNATING_VOWELS.some((group) => group.includes(left) && group.includes(right));
}

// How many more vowels of the stem may alternate in one comparison: «сковор|і|д|ок» «сковор|о|д|а», «сигнал|і|зац|і|я» «сигнал|и|зац|и|и».
const MOST_VOWEL_SWAPS = 2;

// A stem's «й» against the other word's iotated vowel, which says «й» and a vowel: «алюміні|й» «алюміні|єв|у» (the rest «ев|у»), «Андрі|й» «Андрі|я».
function stemJ(said: string, name: string): boolean {
  const [j, other] = said === STEM_J ? [said, name] : [name, said];
  if (j !== STEM_J) return false;
  const vowel = IOTATED.get(other[0] ?? "");
  return vowel !== undefined && IOTATED_VOWELS.includes(other[0] ?? "") && suffixed(`${vowel.slice(1)}${other.slice(1)}`);
}

function tails(said: string, name: string, swaps: number): boolean {
  if (suffixed(said) && suffixed(name)) return true;
  if (stemJ(said, name)) return true;
  if (alternates(said[0], name[0]) && suffixed(said.slice(1)) && suffixed(name.slice(1))) return true;
  if (swaps === 0 || !vowelsAlternate(said[0], name[0])) return false;
  const same = commonStart(said.slice(1), name.slice(1));
  return same > 0 && tails(said.slice(1 + same), name.slice(1 + same), swaps - 1);
}

function commonStart(left: string, right: string): number {
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return length;
}

// What two words of one family add to the stem they share, the letters after `shared`: suffixes and endings only, on both sides; the first letters may be
// consonants that alternate («горі|х» «горі|шки»), and a stem vowel may alternate before the same consonants (uk «і» for «о»: «сковорідок» «сковорода»; uk
// «і» for ru «и»: «пломбір» «пломбир», «карбамід» «карбамид»). Latin words differ at most by a plural ending. `shared` counts letters of the words as given;
// a letter doubled in either («ваніллю», «круассан») counts once.
export function familyTails(spoken: string, known: string, shared: number): boolean {
  const said = Array.from(spoken).slice(shared).join("");
  const name = Array.from(known).slice(shared).join("");
  if (LATIN.test(spoken) && LATIN.test(known)) return LATIN_ENDINGS.includes(said) && LATIN_ENDINGS.includes(name);
  return tails(said, name, MOST_VOWEL_SWAPS);
}

// A word with every doubled letter written once: «ваніллю» «ванілю», «круассан» «круасан».
export function undoubled(word: string): string {
  return word.replace(/(\p{L})\1+/gu, "$1");
}
