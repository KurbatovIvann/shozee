import { LEGAL_FORMS, NAME_ENDINGS, NAME_FOLDS, PLACE_NOUNS } from "./lexicon/customers.ts";
import { FIRST_NAME_GROUPS } from "./lexicon/firstNames.ts";
import { ASR_SLIPS } from "./lexicon/names.ts";
import { sameWord } from "./morphology.ts";
import { startsAlike, wordMatch } from "./words.ts";
import { normalise } from "./text/normalise.ts";

// Known names as people say them (D56): a name's words match their case forms and the recogniser's Russian spelling.

const SHORTEST_STEM = 2;

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// Words folded already: a spoken word is compared with every known name that starts like it, so each word is folded once.
const FOLDED = new Map<string, string>();
const FOLDED_KEPT = 100_000;

function folded(word: string): string {
  const known = FOLDED.get(word);
  if (known !== undefined) return known;
  if (FOLDED.size >= FOLDED_KEPT) FOLDED.clear();
  const fold = Array.from(word, (letter) => NAME_FOLDS.get(letter) ?? letter).join("");
  FOLDED.set(word, fold);
  return fold;
}

const ENDINGS: ReadonlySet<string> = new Set(NAME_ENDINGS.map(folded));

// D92: a known name's words as the utterance's are written: `normalise`d as a spoken text is («Кав'ярня №5» «кав'ярня номер 5», «ТОВ "Сота"» «тов
// сота», «Crumb & Co» «crumb co», «Кав’ярня» «кав'ярня»), so a name said through `run({raw})` meets the name as the host wrote it.
export function nameWords(name: string): string[] {
  return wordsOf(normalise(name));
}

// A long name said in the other language's spelling («нежности» «Ніжність», «творчества» «Творчість», «светлане» «Світлана», D71): uk «і» for ru «е»
// or «о» in the stem, with «и» / «ы» and «е» / «є» / «э» folded as `NAME_FOLDS` does; short names differ by these vowels («Ліна», «Лена»).
const CROSS_VOWELS = /[іиыеєэоёї]/g;
const CROSS_LENGTH = 6;

// A long word may also differ by its suffix as uk and ru words do («творчества» «Творчість», `wordMatch`); a short one would take a surname for a name
// («Іванов» is no «Іван»).
const CROSS_SUFFIX_LENGTH = 8;

function crossSpelling(spoken: string, known: string): boolean {
  const said = Array.from(spoken).length;
  const name = Array.from(known).length;
  if (said < CROSS_LENGTH || name < CROSS_LENGTH || crossKey(spoken) !== crossKey(known)) return false;
  if (sameWord(spoken.replace(CROSS_VOWELS, "е"), known.replace(CROSS_VOWELS, "е"))) return true;
  return said >= CROSS_SUFFIX_LENGTH && name >= CROSS_SUFFIX_LENGTH && wordMatch(spoken, known);
}

// A case form of the word by its paradigm, its folded spelling or its stem and a name ending («саші» Саша, «владимира» Владимир); no prefix and no suffix
// («романенко» is no form of «Роман»).
function caseForm(spoken: string, known: string): boolean {
  if (sameWord(spoken, known)) return true;
  const said = folded(spoken);
  const name = folded(known);
  if (said === name || sameWord(said, name)) return true;
  const stem = ENDINGS.has(name.slice(-1)) ? name.slice(0, -1) : name;
  return stem.length >= SHORTEST_STEM && said.startsWith(stem) && ENDINGS.has(said.slice(stem.length));
}

function plainMatch(spoken: string, known: string): boolean {
  return ASR_SLIPS.get(spoken) === known || startsAlike(spoken, known) || caseForm(spoken, known) || crossSpelling(spoken, known);
}

// D72: the first names a spoken word is a case form of (`lexicon/firstNames.ts`: «владимира» Владимир, so also Володимир, Вова, Володя): the folded
// spelling or the stem and a name ending only, never the paradigm's fleeting vowels («олег» is no «Ольга»); none for a word that is no first name.
// Looked up once a word.
const FIRST_NAME_FORMS: readonly string[] = [...new Set(FIRST_NAME_GROUPS.flat())];
const GROUPS_OF = new Map<string, ReadonlySet<string>>();
const NO_FORMS: ReadonlySet<string> = new Set();

function firstNameForms(spoken: string): ReadonlySet<string> {
  const known = GROUPS_OF.get(spoken);
  if (known !== undefined) return known;
  if (GROUPS_OF.size >= FOLDED_KEPT) GROUPS_OF.clear();
  const own = FIRST_NAME_FORMS.filter((form) => form === spoken || endingForm(spoken, form));
  const forms = own.length ? new Set(FIRST_NAME_GROUPS.filter((group) => group.some((form) => own.includes(form))).flat()) : NO_FORMS;
  GROUPS_OF.set(spoken, forms);
  return forms;
}

function oneWordMatch(spoken: string, known: string): boolean {
  return plainMatch(spoken, known);
}

// A case form of a known word by its folded spelling or its stem and a name ending (D72; D82 `nominative.ts` reads it too).
export function endingForm(spoken: string, known: string): boolean {
  const said = folded(spoken);
  const name = folded(known);
  if (said === name) return true;
  const stem = ENDINGS.has(name.slice(-1)) ? name.slice(0, -1) : name;
  return stem.length >= SHORTEST_STEM && said.startsWith(stem) && ENDINGS.has(said.slice(stem.length));
}

// The spoken words again with one first name said in another of its forms (D72): «владимира бойко» is also «володимир бойко», «вова бойко» … Only
// where the words as said name no customer (`NameList.spokenNames`), so a customer named as said wins («олю» is Оля before Ольга, D56).
function otherFirstNames(spoken: readonly string[]): (readonly string[])[] {
  return spoken.flatMap((word, at) => [...firstNameForms(word)].filter((form) => !endingForm(word, form)).map((form) => [...spoken.slice(0, at), form, ...spoken.slice(at + 1)]));
}

// A spoken word for a word of a known name: the stem rule, a form of the word by its paradigm (D66: «нитці» «Нитка», «віці» «Віка», «павлу» «Павел»), the
// Russian spelling with or without a case ending («ингул» «Інгул», «юрию» «Юрій», «мартынюк» «Мартинюк»), a word the recogniser writes for another («того»
// «ТОВ»); a word joined by a hyphen part by part («дніпро-готелю» «Дніпро-Готель»).
export function nameMatch(spoken: string, known: string): boolean {
  if (spoken === known) return true;
  const said = spoken.split("-");
  const name = known.split("-");
  if (said.length > 1 && said.length === name.length) return said.every((part, index) => oneWordMatch(part, name[index] ?? ""));
  return oneWordMatch(spoken, known);
}

// A name's words, and when a word is joined by a hyphen also its words apart: «Житло-Комфорт» is said «житло-комфорт» and «житло комфорт» (D66).
function wordings(name: string): (readonly string[])[] {
  const words = nameWords(name);
  const apart = words.flatMap((word) => word.split("-").filter(Boolean));
  return apart.length > words.length ? [words, apart] : [words];
}

// How a known name is built, for a name said otherwise than written (D71): its words, which of them are a legal form («ФОП», «ТОВ»), and the words in
// quotes, a place's name proper («Клуб коропарів «Десна»»: «десна»).
interface Shape {
  readonly name: string;
  readonly words: readonly string[];
  readonly legal: readonly boolean[];
  readonly quoted: readonly [start: number, end: number] | null;
}

// A name with more words than this besides a legal form is no person's: its words match in another order or in part only all together.
const PERSON_WORDS = 3;
// The most words a name said otherwise than written may have.
const MOST_SPOKEN = 4;
const SPOKEN_KEPT = 10_000;
const QUOTED = /«([^»]*)»|"([^"]*)"/u;

export function isLegal(word: string): boolean {
  return LEGAL_FORMS.has(word) || LEGAL_FORMS.has(ASR_SLIPS.get(word) ?? "");
}

// «кафе», «клуб»: a word that says what kind of place a customer is, never a name alone («для кафе» is no «Кафе на углу»).
export function placeNoun(word: string): boolean {
  return PLACE_NOUNS.some((noun) => word === noun || sameWord(word, noun));
}

function shapeOf(name: string): Shape {
  const words = nameWords(name);
  const quote = QUOTED.exec(name);
  const inside = quote === null ? [] : nameWords(quote[1] ?? quote[2] ?? "");
  const before = quote === null ? 0 : nameWords(name.slice(0, quote.index)).length;
  const quoted = inside.length > 0 && words.slice(before, before + inside.length).join(" ") === inside.join(" ") ? ([before, before + inside.length] as const) : null;
  return { name, words, legal: words.map(isLegal), quoted };
}

// Every way to pair each spoken word with a distinct word of the name (`nameMatch`; a legal form only with a legal form), as the indices paired.
function pairings(spoken: readonly string[], words: readonly string[], legal: readonly boolean[], from: number, taken: readonly number[], out: number[][]): void {
  if (from === spoken.length) {
    out.push([...taken]);
    return;
  }
  const word = spoken[from] ?? "";
  for (const [at, known] of words.entries()) {
    if (!known || taken.includes(at) || isLegal(word) !== (legal[at] === true) || !nameMatch(word, known)) continue;
    pairings(spoken, words, legal, from + 1, [...taken, at], out);
  }
}

// Does a name said in these words name this known name, in another order or in part (D71)? A person's name (at most three words besides a legal form):
// all its words in any order («гордійчук вікторії» for «Вікторія Гордійчук», «василині гуменюк» for «ФОП Гуменюк Василина»), two of three («тарас
// поліщук» for «Електрик Тарас Поліщук»), one with the legal form («фоп литвиненку» for «ФОП Литвиненко Денис»), or one word alone (the caller takes it
// only when it names one customer). A place's name in quotes, said whole and last, maybe after some of the words before it («клубу десна» for «Клуб
// коропарів «Десна»»).
function fits(spoken: readonly string[], shape: Shape): boolean {
  const found: number[][] = [];
  if (shape.quoted !== null) {
    const [start, end] = shape.quoted;
    const proper = shape.words.slice(start, end);
    const cut = spoken.length - proper.length;
    if (cut < 0 || !proper.every((word, index) => nameMatch(spoken[cut + index] ?? "", word))) return false;
    pairings(spoken.slice(0, cut), shape.words.map((word, at) => (at >= start && at < end ? "" : word)), shape.legal, 0, [], found);
    return found.length > 0;
  }
  const own = shape.legal.filter((legal) => !legal).length;
  pairings(spoken, shape.words, shape.legal, 0, [], found);
  return found.some((paired) => {
    const words = paired.filter((at) => shape.legal[at] !== true).length;
    if (words === 0) return false;
    if (words === own) return true;
    if (own > PERSON_WORDS) return false;
    return words >= 2 || paired.length > words || (spoken.length === 1 && !placeNoun(spoken[0] ?? ""));
  });
}

// The known names of one list (customers), each with its words, indexed by the start of its first word: a spoken word matches a known one (`nameMatch`)
// only when both start with the same two letters once folded, so a lookup reads the few names that start like it, in list order. Since D71 each name is
// also indexed by the start of every word, for a name said in another order or in part (`spokenNames`); `owners` gives the records a name or alias
// belongs to, so that the names and aliases of one customer count once.
export class NameList {
  readonly names: readonly string[];
  private readonly entries: readonly (readonly [name: string, words: readonly string[]])[];
  private readonly byStart = new Map<string, number[]>();
  private readonly shapes: readonly Shape[];
  private readonly byWord = new Map<string, Set<number>>();
  private readonly owners: (name: string) => readonly number[] | string;
  // What `spokenNames` found for each span: a command asks for one span several times (the customer matcher, the chosen customer, the ref).
  private readonly spoken = new Map<string, readonly string[]>();

  constructor(names: readonly string[], owners?: (name: string) => readonly number[]) {
    this.names = names;
    this.owners = owners ?? ((name) => name);
    this.entries = names.flatMap((name) => wordings(name).map((words) => [name, words] as const));
    for (const [index, [, words]] of this.entries.entries()) {
      for (const key of startKeys(words[0] ?? "")) {
        const list = this.byStart.get(key);
        if (list === undefined) this.byStart.set(key, [index]);
        else list.push(index);
      }
    }
    this.shapes = names.map(shapeOf);
    for (const [index, shape] of this.shapes.entries()) {
      for (const word of shape.words) {
        for (const key of startKeys(word)) {
          const set = this.byWord.get(key);
          if (set === undefined) this.byWord.set(key, new Set([index]));
          else set.add(index);
        }
      }
    }
  }

  get length(): number {
    return this.names.length;
  }

  // The names whose first word the spoken word may match, in list order: each name and its words (a hyphenated name twice, joined and apart).
  startingWith(spoken: string): readonly (readonly [name: string, words: readonly string[]])[] {
    const keys = startKeys(spoken);
    const found = keys.length === 1 ? (this.byStart.get(keys[0] ?? "") ?? []) : [...new Set(keys.flatMap((key) => this.byStart.get(key) ?? []))].sort((left, right) => left - right);
    return found.flatMap((index) => {
      const entry = this.entries[index];
      return entry === undefined ? [] : [entry];
    });
  }

  // The names every spoken word may match a word of, in list order.
  private reaching(spoken: readonly string[]): number[] {
    let kept: number[] | null = null;
    for (const word of spoken) {
      const found = new Set(startKeys(word).flatMap((key) => [...(this.byWord.get(key) ?? [])]));
      if (!found.size) return [];
      kept = kept === null ? [...found] : kept.filter((index) => found.has(index));
      if (!kept.length) return [];
    }
    return (kept ?? []).sort((left, right) => left - right);
  }

  private fitting(spoken: readonly string[]): Shape[] {
    return this.reaching(spoken).flatMap((index) => {
      const shape = this.shapes[index];
      return shape !== undefined && fits(spoken, shape) ? [shape] : [];
    });
  }

  // The customers a name said in another order or in part names (D71, `fits`), one name each (the first of its names and aliases that fits), in list
  // order; a place noun before a name that does not hold it is skipped («кафе ромашка» for «Ромашка», «клубу десна» for «Десна»). A name resolves only
  // when one customer is found; several are the candidates of an ambiguous ref.
  spokenNames(spoken: readonly string[]): string[] {
    if (!spoken.length || spoken.length > MOST_SPOKEN) return [];
    const key = spoken.join(" ");
    const known = this.spoken.get(key);
    if (known !== undefined) return [...known];
    if (this.spoken.size >= SPOKEN_KEPT) this.spoken.clear();
    const found = this.spokenOf(spoken);
    this.spoken.set(key, found);
    return [...found];
  }

  private spokenOf(spoken: readonly string[]): string[] {
    let found = this.fitting(spoken);
    if (!found.length && spoken.length > 1 && placeNoun(spoken[0] ?? "")) found = this.fitting(spoken.slice(1));
    if (!found.length) found = [...new Set(otherFirstNames(spoken).flatMap((other) => this.fitting(other)))];
    const byOwner = new Map<string, string>();
    for (const shape of found) {
      const key = String(this.owners(shape.name));
      if (!byOwner.has(key)) byOwner.set(key, shape.name);
    }
    return [...byOwner.values()];
  }
}

function startKey(word: string): string {
  return Array.from(folded(word)).slice(0, SHORTEST_STEM).join("");
}

// The keys a word is indexed and looked up by: its start once folded, and for a long word also its first three letters with the uk / ru vowels folded
// (`crossSpelling`, D71: «нежности» and «ніжність» start alike).
const CROSS_KEY = 3;
const CROSS_KEYS = new Map<string, string>();

function crossKey(word: string): string {
  const known = CROSS_KEYS.get(word);
  if (known !== undefined) return known;
  if (CROSS_KEYS.size >= FOLDED_KEPT) CROSS_KEYS.clear();
  const key = Array.from(word.replace(CROSS_VOWELS, "е")).slice(0, CROSS_KEY).join("");
  CROSS_KEYS.set(word, key);
  return key;
}

function startKeys(word: string): string[] {
  const key = startKey(word);
  if (Array.from(word).length < CROSS_LENGTH) return [key];
  return [key, `~${crossKey(word)}`];
}

